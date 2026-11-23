# MCP File Reader (Node.js)

```
                        ┌──── LLM (Claude / OpenAI / Ollama) ────┐
                        │      decides which tools to call       │
User ──natural language──▶ Chatbot ──stdio/MCP──▶ MCP Server ──HTTP──▶ File-Reading Server ──fs──▶ Local Files
       (web or terminal)   chatbot/               mcp-server/           file-server/

Client Application (scripted CLI) ──stdio/MCP──▶ MCP Server ──▶ …        client/
```

## Chatbot (natural language + LLM)

Ask things like *"which region had the best Q2 in budget.xlsx?"*, *"summarize chapter 2 of stories.epub"* or *"find every file that mentions invoices in ~/Documents"*. The LLM picks the MCP tools, reads only the pages it needs, and answers, citing the file and page.

```bash
npm install
npm run start:file-server                    # terminal 1

# terminal 2: pick an LLM (or none: offline rules mode)
export ANTHROPIC_API_KEY=sk-ant-...          # Claude
# or: export OPENAI_API_KEY=sk-...           # OpenAI
# or: export LLM_PROVIDER=ollama LLM_MODEL=qwen2.5:7b   # local model via Ollama

npm run chatbot                              # web chat → http://localhost:3000
npm run chatbot:cli                          # terminal chat (/reset, /exit)
```

| Provider | `LLM_PROVIDER` | Needs | Default model |
|---|---|---|---|
| Claude | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| Ollama (local) | `ollama` | `ollama serve` + a model with tool calling (Qwen 2.5, Llama 3.1+, Mistral…) | `qwen2.5:7b` |
| Any OpenAI-compatible API | `openai-compatible` | `LLM_BASE_URL`, `OPENAI_API_KEY` | set `LLM_MODEL` |
| Offline, no LLM | `rules` | nothing | keyword rules |

If `LLM_PROVIDER` isn't set, the chatbot uses Claude when `ANTHROPIC_API_KEY` is present, then OpenAI when `OPENAI_API_KEY` is present, and otherwise runs in **offline rules mode**. That mode handles simple, one-step requests ("read page 2 of report.pdf", "list files in office", "find Pune in budget.xlsx") so you can try everything without a key. Instead of exporting variables, you can copy `chatbot/.env.example` to `chatbot/.env` and edit it.

**How it works:** each message goes to the LLM together with the six MCP tool definitions. When the LLM requests tools, the chatbot runs them through the MCP server (calls in the same round run in parallel) and sends the results back. This repeats until the LLM answers, up to `MAX_TOOL_ROUNDS` (8). Each browser tab has its own conversation, so follow-up questions work ("and what about sheet 2?"). Large tool results are cut at `MAX_TOOL_RESULT_CHARS`, and old turns are dropped after `MAX_HISTORY_MESSAGES`. The web page shows each tool call live; click one to see its result.

To add another LLM, implement the four methods listed in `chatbot/src/llm/index.js`.

Reads files from **any path you give it** (absolute, `~/…`, or relative) inside the folders you allow, in **20+ formats**. It can return file details, full text, or specific pages, sheets, slides, chapters or paragraphs, and it can search one file or a whole folder.

Requires Node.js 18+ (tested on Node 22).

## Deploy to Railway

```
Internet ──https──▶ chatbot ──private──▶ mcp-server ──private──▶ file-server ──▶ volume /data
                 (public URL,          (MCP over HTTP,          (token-protected,
                  login + rate limit)   bearer token)            uploads + samples)
```

Three Railway services, each built from its own Dockerfile at the repository root. Only the chatbot is public. The other two talk over Railway's private network (`<service>.railway.internal`). Files live on a Railway volume mounted at `/data`; on first boot it's seeded with the sample files, and files you upload in the chat (📎 button or drag-and-drop) go to `/data/uploads`.

> Railway's old `railway.json` / `railway.toml` setup is deprecated (new services can't use it, and it stops working on 2026-12-01). This project uses its replacement, **Infrastructure as Code** in `.railway/railway.ts`.

### Option A: Infrastructure as Code (recommended)

Needs Railway CLI 5.42.1 or newer (`npm i -g @railway/cli` or `brew install railway`), and the repo pushed to GitHub with Railway's GitHub app allowed to access it.

```bash
npm install                                   # installs the `railway` SDK that railway.ts imports
npm run railway:check                         # type-checks railway.ts and prints what it will create (no account needed)

railway login
railway init                                  # new project (or: railway link)
export RAILWAY_GITHUB_REPO=your-user/mcp-file-reader   # optional: RAILWAY_GITHUB_BRANCH (default main)
railway config plan                           # review
railway config apply                          # creates 3 services + the volume

# Secrets: set once. The other services pick them up through Railway references.
railway variable set FILE_SERVER_TOKEN=$(openssl rand -hex 32) --service file-server
railway variable set MCP_AUTH_TOKEN=$(openssl rand -hex 32)    --service mcp-server
railway variable set CHATBOT_PASSWORD='choose-a-password'      --service chatbot
railway variable set ANTHROPIC_API_KEY=sk-ant-...              --service chatbot   # or OPENAI_API_KEY / LLM_PROVIDER=ollama + LLM_BASE_URL

railway domain --service chatbot              # public https URL for the chat
```

Open the URL and log in as `admin` with your `CHATBOT_PASSWORD`. Later `railway config apply` runs keep the secrets: `railway.ts` marks them `preserve()`. If a variable command differs in your CLI version, check `railway variable --help`, or set the values in the dashboard (service → Variables).

**Without GitHub:** leave `RAILWAY_GITHUB_REPO` unset when you apply, then deploy your local copy from the repository root:

```bash
railway up --service file-server && railway up --service mcp-server && railway up --service chatbot
```

### Option B: Dashboard only

1. New project → **Deploy from GitHub repo** → pick this repo. Do it three times (or duplicate the service) and name the services `file-server`, `mcp-server` and `chatbot`. Leave **Root Directory** empty for all three.
2. Variables for each service (the `${{…}}` references are typed exactly like this in Railway):

| file-server | mcp-server | chatbot |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH=file-server/Dockerfile` | `RAILWAY_DOCKERFILE_PATH=mcp-server/Dockerfile` | `RAILWAY_DOCKERFILE_PATH=chatbot/Dockerfile` |
| `PORT=4000` | `PORT=8080` | `PORT=3000` |
| `DATA_DIR=/data` | `MCP_TRANSPORT=http` | `MCP_SERVER_URL=http://${{mcp-server.RAILWAY_PRIVATE_DOMAIN}}:8080/mcp` |
| `FILE_SERVER_TOKEN=<random>` | `FILE_SERVER_URL=http://${{file-server.RAILWAY_PRIVATE_DOMAIN}}:4000` | `MCP_AUTH_TOKEN=${{mcp-server.MCP_AUTH_TOKEN}}` |
| | `FILE_SERVER_TOKEN=${{file-server.FILE_SERVER_TOKEN}}` | `FILE_SERVER_URL=http://${{file-server.RAILWAY_PRIVATE_DOMAIN}}:4000` |
| | `MCP_AUTH_TOKEN=<random>` | `FILE_SERVER_TOKEN=${{file-server.FILE_SERVER_TOKEN}}` |
| | | `CHATBOT_PASSWORD`, `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) |

3. **file-server** → right-click → **Attach volume**, mount path `/data`.
4. **chatbot** → Settings → Networking → **Generate Domain**. Health check paths: `/health` (file-server, mcp-server) and `/api/health` (chatbot).

### Good to know

- **Health checks and start order:** the chatbot starts serving immediately and connects to the MCP server in the background, so the services can boot in any order. Until it's connected, chat requests return "Still connecting…".
- **Security:** set `CHATBOT_PASSWORD` (anyone with the URL could otherwise use your LLM key) and both tokens. Chat messages are limited to `RATE_LIMIT_PER_MIN` (20) per IP. Uploads are size-limited (`MAX_UPLOAD_MB`, 50) and saved under safe names, never overwriting.
- **Replicas:** keep the chatbot at 1 replica (conversations are kept in memory) and the file server at 1 (a volume attaches to one service). The MCP server is stateless and can scale.
- **Using the MCP server from other clients** (Claude Desktop, your own agents): give **mcp-server** a public domain, keep `MCP_AUTH_TOKEN` set, and connect to `https://<domain>/mcp` with `Authorization: Bearer <token>`. The CLI client works too: `MCP_SERVER_URL=https://<domain>/mcp MCP_AUTH_TOKEN=… npm run client -- info`.
- **IPv6:** the services listen on `::` (IPv4 + IPv6), as Railway's private network requires, and fall back to `0.0.0.0` on machines without IPv6.

### Run the same setup locally with Docker

```bash
cp .env.example .env          # set the tokens, password and an LLM key
docker compose up --build     # http://localhost:3000
```

## Run it (without Docker)

```bash
npm install

# Terminal 1: File-Reading Server
npm run start:file-server
#   default: can read ./sample-files and your home folder

# Terminal 2: Client (it starts the MCP server itself)
npm run demo                                  # tour of every format in sample-files
npm run client                                # interactive menu
npm run client -- info                        # allowed folders + formats
npm run client -- list ~/Documents -r --formats pdf,docx
npm run client -- details ~/Downloads/report.pdf /data/budget.xlsx
npm run client -- text ~/Downloads/report.pdf --pages 2-3
npm run client -- text ~/Documents/budget.xlsx --pages 2       # sheet 2
npm run client -- text ~/Documents/deck.pptx --paragraphs 1-4
npm run client -- search ~/Documents/guide.docx onboarding
npm run client -- grep invoice --dir ~/Documents -r
```

## Which paths can be read

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ROOTS` | `sample-files` + your home folder | Folders that may be read, separated by `:` (macOS/Linux) or `;` (Windows). `*` allows any path. |
| `DEFAULT_DIR` | first allowed root | Where relative paths resolve. |

```bash
ALLOWED_ROOTS="$HOME/Documents:/mnt/shared" npm run start:file-server     # macOS / Linux
set ALLOWED_ROOTS=C:\Users\me\Documents;D:\Reports && npm run start:file-server   # Windows cmd
ALLOWED_ROOTS="*" npm run start:file-server                                # anything (trusted machines only)
```

Paths are resolved with symlinks followed, so `../` tricks and symlinks that point outside an allowed folder are refused. The server listens on `127.0.0.1` only.

Other settings: `PORT` (4000), `HOST` (127.0.0.1), `MAX_FILE_MB` (100), `CHARS_PER_PAGE` (3000, virtual page size), and `FILE_SERVER_URL` for the MCP server and client.

## Supported formats

| Format | Extensions | A "page" is | A "paragraph" is | Metadata |
|---|---|---|---|---|
| PDF | .pdf | PDF page | Line-based guess | title, author, producer |
| Word | .docx .docm .dotx | Page break / Word's last layout, else virtual | Word paragraph; table row = `a \| b` | title, author, dates |
| Word 97-2003 | .doc .dot | Manual page break, else virtual | Paragraph | – |
| OpenDocument text | .odt .ott | LibreOffice layout break, else virtual | Paragraph; table row | title, author, dates |
| Rich Text | .rtf | `\page` / page-break-before, else virtual | `\par` | – |
| Spreadsheets | .xlsx .xlsm .xlsb .xls .ods .csv .tsv | **Sheet** | Row (`a \| b \| c`) | sheet names and sizes |
| PowerPoint | .pptx .pptm .ppsx .potx | **Slide** (in presentation order) | Text paragraph; notes as `[Notes] …` | title, dates |
| OpenDocument slides | .odp | **Slide** | Text paragraph + notes | title, author |
| Web page | .html .htm .xhtml | Virtual | Block of text (scripts/styles dropped) | title |
| E-book | .epub | **Chapter** (reading order) | Paragraph | title, author, language |
| Text & code | .txt .md .json .xml .yaml .log .csv-like, source code, config … | Form feed `\f`, else virtual | Blank-line separated | encoding, line count |

- **Detected by content, not just extension.** A PDF named `report` or a .docx renamed to `.dat` is still read correctly. Unknown extensions that look like text are read as text, with the encoding detected (UTF-8, UTF-16, Latin-1, etc.).
- **Virtual pages** are about `CHARS_PER_PAGE` characters, split at paragraph boundaries. Very long paragraphs (such as log files) are split at line breaks.
- **Not supported, with a clear message:** legacy .ppt, Apple Pages/Numbers/Keynote, images (would need OCR), archives.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `get_server_info` | – | Allowed folders, default folder, formats |
| `list_files` | `dir?`, `recursive?`, `formats?`, `limit?` | Files and subfolders with format, size, date |
| `get_file_details` | `path` | Size, dates, detected format, page/sheet/slide/chapter count and labels, paragraphs, words, metadata |
| `extract_text` | `path`, `pages?` **or** `paragraphs?`, `maxChars?` | Selected sections with labels + combined text |
| `search_file` | `path`, `query`, `caseSensitive?`, `maxResults?` | Matches with page, paragraph and snippet |
| `search_directory` | `dir?`, `query`, `recursive?`, `formats?`, … | Matches across every readable file in a folder |

Ranges are 1-based: `3`, `1-4`, `1,3,5-7`.

### Use the MCP server from Claude Desktop (optional)

With the file server running, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "file-reader": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-file-reader/mcp-server/src/index.js"],
      "env": { "FILE_SERVER_URL": "http://localhost:4000" }
    }
  }
}
```

## File-Reading Server HTTP API

| Endpoint | Description |
|---|---|
| `GET /health` | Status |
| `GET /formats` | Supported and unsupported formats |
| `GET /roots` | Allowed folders and default folder |
| `GET /files?dir=&recursive=&formats=pdf,docx&limit=` | List a folder |
| `GET /files/details?path=` | File details |
| `GET /files/text?path=&pages=1-2` or `&paragraphs=3,5` or neither, `&maxChars=` | Text |
| `GET /files/search?path=&query=&caseSensitive=&maxResults=` | Search one file |
| `GET /search?dir=&query=&recursive=&formats=&maxResults=` | Search a folder |
| `POST /files/upload?name=report.pdf` | Raw file bytes → saved in `UPLOAD_DIR` (default `DATA_DIR/uploads`) |

With `FILE_SERVER_TOKEN` set, every route except `/health` needs `Authorization: Bearer <token>`. `DATA_DIR` (or Railway's `RAILWAY_VOLUME_MOUNT_PATH`) makes that folder the only readable root and turns uploads on.

Errors are `{ "error": "…" }` with 400 (bad input), 403 (outside allowed folders), 404, 413 (too large), 415 (unsupported format), 416 (page out of range), or 422 (corrupt or password-protected).

## Adding a format

Create `file-server/src/extractors/myformat.js`:

```js
export default {
  id: 'myformat',
  label: 'My format',
  extensions: ['.myf'],
  async extract(buffer, { ext, path, decodeText }) {
    // Either native pages...
    return { unit: 'page', pageSource: 'native', pages: [{ label: 'Intro', paragraphs: ['…'] }], metadata: {} };
    // ...or just paragraphs (virtual pages are made for you):
    // return { unit: 'page', paragraphs: ['…', '…'], metadata: {} };
  },
};
```

Then add it to `EXTRACTORS` in `extractors/index.js`. To detect it by content, add a magic-byte check in `detectFormat`.

## Project layout

```
mcp-file-reader/
├── file-server/src/
│   ├── server.js            HTTP routes (+ POST /files/upload)
│   ├── storage.js           volume seeding, uploads, token auth
│   ├── config.js            env settings (roots, limits)
│   ├── paths.js             path resolution, allowed-folder checks, directory walking
│   ├── document.js          normalizes any extractor output, virtual pages, cache, ranges
│   └── extractors/
│       ├── index.js         registry + content-based format detection
│       ├── pdf.js  word.js  spreadsheet.js  presentation.js  documents.js  text.js  util.js
├── .railway/railway.ts      Railway Infrastructure as Code (3 services + volume); inspect.mjs previews it
├── docker-compose.yml       same 3-service setup locally
├── */Dockerfile             one per service, built from the repo root
├── mcp-server/src/
│   ├── index.js             entry point: stdio or Streamable HTTP (MCP_TRANSPORT=http)
│   └── tools.js             MCP tools → HTTP calls to the file server
├── client/src/app.js        MCP client CLI (demo, commands, interactive menu)
├── chatbot/
│   ├── src/server.js        web server: chat page + /api/chat (Server-Sent Events)
│   ├── src/cli.js           terminal chat
│   ├── src/agent.js         LLM ↔ tool-call loop, per-session history
│   ├── src/mcp.js           MCP client (spawns mcp-server)
│   ├── src/config.js        settings + system prompt
│   ├── src/llm/             anthropic.js, openai.js (OpenAI/Ollama/compatible), rules.js (offline)
│   └── public/index.html    chat UI (no build step)
└── sample-files/            one file per format (+ a PDF without extension and a renamed .docx)
```
