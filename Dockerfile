FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000 \
    HOST=0.0.0.0 \
    WHISPER_MODEL_SIZE=large-v3 \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    WHISPER_CACHE_DIR=/tmp/whisper-cache \
    WHISPER_PRELOAD=0 \
    TRANSCRIBE_CONCURRENCY=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY app.py ./

EXPOSE 3000

CMD ["python", "app.py"]
