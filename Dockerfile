FROM python:3.12-slim

WORKDIR /app

# gcc/libsndfile-ish build deps for numpy/webrtcvad-wheels if no prebuilt wheel matches
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server ./server
COPY static ./static

# Persistent data lives on a mounted volume in production; keep a local
# fallback so the app still boots (and seeds an admin account) without one.
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
