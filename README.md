# unopenrouter runner

Run your own [unopenrouter](https://unopenrouter.com) runner: your Claude and ChatGPT logins stay on your machine.

The runner is a small program for your own computer, Pi or server. It runs the `claude` and `codex` CLIs under
your logins and answers the model requests that your unopenrouter API keys send. Full guide:
https://unopenrouter.com/runner

## What it does, and what it never does

- It keeps one outbound WebSocket to the server. It opens no port.
- It only runs model requests: a prompt in, the model's answer out. The CLIs run with every tool turned off.
- The server gets no shell and no file access. The protocol has no message for either, and the runner refuses
  any message it does not know. See [`src/runner/protocol.ts`](src/runner/protocol.ts).
- Your logins stay on this machine. The Claude token and the Codex login are never sent to the server.

## Install

Make a pairing code in the dashboard first: **Runners → Add runner**. The code works once, for 15 minutes.

Your own computer (Node 22 and the CLIs: `npm install -g @anthropic-ai/claude-code @openai/codex`):

    npx @unopenrouter/runner pair <code>
    npx @unopenrouter/runner login claude     # and/or: login codex
    npx @unopenrouter/runner                  # start it, and keep it running

A Debian, Ubuntu or Raspberry Pi OS box, as a systemd service (the script installs Node 22 and both CLIs):

    curl -fsSL https://unopenrouter.com/install-runner.sh | sudo bash
    sudo -u unopenrouter-runner -H unopenrouter-runner pair <code>
    sudo -u unopenrouter-runner -H unopenrouter-runner login claude

Docker (with both CLIs, from this repo's `Dockerfile`):

    docker build -t unopenrouter-runner https://unopenrouter.com/unopenrouter-runner-docker.tgz
    docker run -d --restart unless-stopped --name unopenrouter-runner -v unor-runner:/data unopenrouter-runner
    docker exec -it unopenrouter-runner unopenrouter-runner pair <code>
    docker exec -it unopenrouter-runner unopenrouter-runner login claude

## Pairing and logins

`pair <code>` swaps the code for a runner token and keeps it in `~/.config/unopenrouter-runner/config.json`
(or `$UNOR_RUNNER_HOME`). Revoke the runner in the dashboard to end that token.

- **Claude:** run `claude setup-token` on your own computer, then `login claude` on the runner and paste the token.
- **Codex (ChatGPT):** run `login codex` on the runner and follow the device-code steps it shows.

Use `--name` to keep more than one login apart. Other commands: `accounts`, `logout <name>`, `version`.

## What data leaves the machine

To the unopenrouter server, over the WebSocket:

- the runner token, the runner version and the protocol version;
- each login's name, provider, plan, usage windows (percent used, reset time) and whether it works;
- the model's answer to each request, as it streams, with its token counts.

To Anthropic and OpenAI: the requests themselves, made by their own CLIs from this machine's IP, and a usage
check every 10 minutes.

Transcripts stay on the runner. With "Don't store my data" on (the default), the runner deletes them after
3 idle hours. Start it with `--keep-transcripts` to keep them.

## Build from source

Node 20 or later:

    npm ci
    npm run build    # writes dist/unopenrouter-runner.mjs
    npm test

## Licence

MIT. See [LICENSE](LICENSE).
