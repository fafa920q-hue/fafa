FROM python:3.12-slim
WORKDIR /agent
COPY backend/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock
COPY --chown=10002:10002 agent /agent/agent
RUN useradd --uid 10002 --create-home nodeagent && mkdir -p /data/configs && chown -R 10002:10002 /data
USER 10002:10002
EXPOSE 8100
CMD ["uvicorn","agent.main:app","--host","0.0.0.0","--port","8100","--no-access-log"]
