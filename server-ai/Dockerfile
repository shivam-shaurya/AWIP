# server-ai — FastAPI + the kb-extract-rig OCR/extraction engine.
# document_extract.py imports ../kb-extract-rig, so this image must be built
# with the REPO ROOT as context:
#   docker build -f server-ai/Dockerfile .
# (docker-compose.prod.yml does this; server-ai/Dockerfile.dockerignore trims
# the context to just server-ai/ + kb-extract-rig/.)
# python:3.13-slim matches kb-extract-rig's pinned wheels (numpy 2.4 needs >=3.11).
FROM python:3.13-slim
WORKDIR /app/server-ai
COPY server-ai/requirements.txt /app/server-ai/requirements.txt
COPY kb-extract-rig/requirements.txt /app/kb-extract-rig/requirements.txt
# opencv-python needs libGL (absent in slim); kb-extract-rig degrades gracefully
# without cv2, so skip it rather than bloat the image with GL libraries.
RUN grep -Ev "^opencv-python" /app/kb-extract-rig/requirements.txt > /tmp/kb-req.txt \
    && pip install --no-cache-dir -r /app/server-ai/requirements.txt -r /tmp/kb-req.txt
COPY kb-extract-rig/ /app/kb-extract-rig/
COPY server-ai/ /app/server-ai/
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
