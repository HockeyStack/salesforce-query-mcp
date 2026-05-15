module.exports = {
  apps: [
    {
      name: "mcp-server",
      script: "./build/index.js",
      cwd: "/home/revops-mcp/salesforce-query-mcp",
      interpreter: "node",
      env_file: "/home/revops-mcp/salesforce-query-mcp/.env",
      // HTTP mode - MCP_HTTP_PORT being set is what switches the server from stdio to HTTP
      env: {
        NODE_ENV: "production",
        MCP_HTTP_PORT: "3001",
      },
      // Restart if it crashes, back off up to 10s between retries
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      // Log locations
      out_file: "/var/log/revops-mcp/mcp-server.log",
      error_file: "/var/log/revops-mcp/mcp-server.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "slack-bot",
      script: "./slack-bot/build/index.js",
      cwd: "/home/revops-mcp/salesforce-query-mcp",
      interpreter: "node",
      env_file: "/home/revops-mcp/salesforce-query-mcp/.env",
      env: {
        NODE_ENV: "production",
        SLACK_PORT: "3000",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      exp_backoff_restart_delay: 100,
      out_file: "/var/log/revops-mcp/slack-bot.log",
      error_file: "/var/log/revops-mcp/slack-bot.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
