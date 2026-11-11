FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive TZ=America/Sao_Paulo DISPLAY=:99 LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tzdata python3 python3-websocket xvfb openbox tint2 scrot \
    x11-utils dbus-x11 fonts-liberation fonts-noto-core mousepad galculator \
    && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 capture
RUN apt-get update && apt-get install -y --no-install-recommends python3-docx && rm -rf /var/lib/apt/lists/*
COPY --chown=capture:capture desktop /home/capture/.config
COPY policies.json /etc/opt/chrome/policies/managed/capture.json
COPY *.py /opt/capture/
USER capture
WORKDIR /opt/capture
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=4s --start-period=30s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=3)"
CMD ["python3", "-u", "app.py"]
