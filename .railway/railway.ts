// Railway Infrastructure as Code for the MCP File Reader.
//
//   Internet ──▶ chatbot (public URL) ──private──▶ mcp-server ──private──▶ file-server ──▶ volume /data
//
// Only the chatbot gets a public URL. The MCP server and file server talk over Railway's
// private network (<service>.railway.internal), and the file server keeps files on a volume.
//
// Usage (Railway CLI 5.42.1+, from the repository root):
//   npm install                      # installs the `railway` SDK this file imports
//   railway login && railway init    # or `railway link` to an existing project
//   RAILWAY_GITHUB_REPO=you/mcp-file-reader railway config plan     # preview
//   RAILWAY_GITHUB_REPO=you/mcp-file-reader railway config apply    # create / update
// Then set the secrets (see README "Deploy to Railway") and add a public domain to the chatbot.
//
// Leave RAILWAY_GITHUB_REPO unset to create the services without a repo and deploy them with
// `railway up --service <name>` from your machine instead.

import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

const repo = process.env.RAILWAY_GITHUB_REPO; // "owner/repo"
const branch = process.env.RAILWAY_GITHUB_BRANCH || "main";

const FILE_SERVER_PORT = "4000";
const MCP_SERVER_PORT = "8080";
const CHATBOT_PORT = "3000";

// All services build the same root Dockerfile; the SERVICE variable picks what runs (see start.js).
// Watch patterns stop, say, a chatbot UI change from redeploying the file server.
function dockerBuild(dir: string, alsoWatch: string[] = []) {
  return {
    builder: "DOCKERFILE" as const,
    dockerfilePath: "Dockerfile",
    watchPatterns: [`${dir}/**`, "Dockerfile", "start.js", "package.json", "package-lock.json", ...alsoWatch],
  };
}

function deploy(healthcheckPath: string) {
  return {
    healthcheckPath,
    healthcheckTimeout: 120,
    restartPolicyType: "ON_FAILURE" as const,
    restartPolicyMaxRetries: 10,
  };
}

export default defineRailway((ctx) => {
  const source = repo ? github(repo, { branch }) : undefined;

  // Persistent storage for uploaded files. Seeded with the sample files on first boot.
  const fileData = volume("file-data");

  const fileServer = service("file-server", {
    source,
    build: dockerBuild("file-server", ["sample-files/**"]),
    deploy: deploy("/health"),
    volumeMounts: { "/data": fileData },
    env: {
      PORT: FILE_SERVER_PORT,
      HOST: "::",
      DATA_DIR: "/data",
      MAX_FILE_MB: "50",
      SERVICE: "file-server",
      // Shared secret for service-to-service calls. Set it once (see README); others reference it.
      FILE_SERVER_TOKEN: preserve(),
    },
  });

  const mcpServer = service("mcp-server", {
    source,
    build: dockerBuild("mcp-server"),
    deploy: deploy("/health"),
    env: {
      PORT: MCP_SERVER_PORT,
      HOST: "::",
      MCP_TRANSPORT: "http",
      SERVICE: "mcp-server",
      FILE_SERVER_HOST: fileServer.env.RAILWAY_PRIVATE_DOMAIN,
      FILE_SERVER_PORT: FILE_SERVER_PORT,
      FILE_SERVER_TOKEN: fileServer.env.FILE_SERVER_TOKEN,
      // Required if you ever give this service a public URL (e.g. for Claude Desktop).
      MCP_AUTH_TOKEN: preserve(),
    },
  });

  const chatbot = service("chatbot", {
    source,
    build: dockerBuild("chatbot", ["mcp-server/**"]),
    deploy: deploy("/health"),
    env: {
      PORT: CHATBOT_PORT,
      HOST: "::",
      SERVICE: "chatbot",
      MCP_SERVER_HOST: mcpServer.env.RAILWAY_PRIVATE_DOMAIN,
      MCP_SERVER_PORT: MCP_SERVER_PORT,
      MCP_AUTH_TOKEN: mcpServer.env.MCP_AUTH_TOKEN,
      FILE_SERVER_HOST: fileServer.env.RAILWAY_PRIVATE_DOMAIN,
      FILE_SERVER_PORT: FILE_SERVER_PORT,
      FILE_SERVER_TOKEN: fileServer.env.FILE_SERVER_TOKEN,
      MAX_UPLOAD_MB: "50",
      RATE_LIMIT_PER_MIN: "20",
      // Secrets and choices you set yourself; preserve() keeps whatever is set in Railway.
      CHATBOT_PASSWORD: preserve(),
      LLM_PROVIDER: preserve(),
      LLM_MODEL: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      OPENAI_API_KEY: preserve(),
    },
  });

  return project(ctx.projectName || "mcp-file-reader", {
    resources: [fileServer, mcpServer, chatbot, fileData],
  });
});
