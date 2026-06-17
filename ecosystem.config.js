// pm2 process definition for the attendance Discord bot.
// Used by the npm scripts: `npm run bot:start` and `npm run deploy`.
// `cwd` defaults to this file's directory, so the relative `--env-file=.env`
// resolves to the repo's own .env (keep .env + serviceAccount.json here).
module.exports = {
  apps: [
    {
      name: "bma-bot",
      script: "discord-bot.js",
      // Pass node the --env-file flag so the bot's env vars load (same as
      // `npm run bot`). pm2 does not read .env on its own.
      node_args: "--env-file=.env",
      autorestart: true,
      // Back off instead of hot-looping if the bot keeps crashing on boot.
      restart_delay: 5000,
      max_restarts: 10,
    },
  ],
};
