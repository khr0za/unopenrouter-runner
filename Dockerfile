# The unopenrouter runner with both CLIs. Build it where it will run (amd64 or arm64):
#   docker build -t unopenrouter-runner https://unopenrouter.com/unopenrouter-runner-docker.tgz
#   docker run -d --restart unless-stopped --name unopenrouter-runner -v unor-runner:/data unopenrouter-runner
#   docker exec -it unopenrouter-runner unopenrouter-runner pair <code>
FROM node:22-bookworm-slim
RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force
COPY unopenrouter-runner.tgz /tmp/
RUN npm install -g /tmp/unopenrouter-runner.tgz && rm /tmp/unopenrouter-runner.tgz && npm cache clean --force
RUN useradd --create-home --uid 10001 runner && mkdir /data && chown runner /data
USER runner
ENV UNOR_RUNNER_HOME=/data
VOLUME /data
ENTRYPOINT ["unopenrouter-runner"]
CMD ["start"]
