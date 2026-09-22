module.exports = {
  apps: [{
    name: "jev-sniper",
    script: "node_modules/.bin/tsx",
    args: "src/index.ts",
    cwd: __dirname,
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 50,
    env: { NODE_ENV: "production" },
  }],
};
