#!/usr/bin/env bash
# =============================================================================
# setup_server.sh - one-shot environment setup for kb-extract-rig on
#                   Ubuntu + NVIDIA GPU (built/tested target: Ubuntu 24.04,
#                   Python 3.12, Tesla T4).
#
# RUN IT FROM THE REPO ROOT, in an interactive terminal (it's long: ~15-30 min,
# mostly downloads), NOT over a short-lived SSH command:
#       cd ~/kb-extract-rig && bash setup_server.sh
#
# Safe to re-run. Installs: system libs -> a venv -> CUDA PyTorch -> the rig's
# core + GPU-OCR + schedule deps -> Docling (sovereign comparison engine).
# PaddleOCR is a SEPARATE optional step at the bottom (it can conflict with
# numpy 2.x, so it goes in its own venv to avoid breaking the rig).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"

echo "======================================================================"
echo " kb-extract-rig server setup   ($(python3 --version), $(hostname))"
echo "======================================================================"

echo "--- [1/6] system packages (sudo) ---"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  python3-venv python3-pip \
  tesseract-ocr tesseract-ocr-hin tesseract-ocr-mar \
  default-jre \
  libreoffice \
  libgl1 libglib2.0-0 \
  poppler-utils
echo "    tesseract: $(tesseract --version 2>&1 | head -1)"
echo "    java:      $(java -version 2>&1 | head -1)"

echo "--- [2/6] python venv (rig) ---"
python3 -m venv venv
# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --upgrade pip wheel

echo "--- [3/6] PyTorch + torchvision (CUDA 12.4 build; supports Tesla T4) ---"
# The rig assumes torch is present; this fresh server has none. cu124 is broadly
# compatible. If your driver is older and this fails, try .../whl/cu121.
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

echo "--- [4/6] rig CORE deps ---"
# Pins were captured on Python 3.13; on 3.12 they normally resolve. If a single
# pin has no 3.12 wheel, drop its '==version' and re-run.
pip install -r requirements.txt

echo "--- [5/6] GPU-OCR + schedule + Docling ---"
# torch/torchvision already installed above, so these won't pull a CPU torch.
pip install python-doctr pytesseract scikit-image xlrd img2table Pillow reportlab scipy
pip install mpxj                       # schedule parser (uses the JRE from step 1)
pip install docling                    # sovereign comparison engine (IBM, MIT)

echo "--- [6/6] smoke test ---"
set +e
python -c "import torch; print('CUDA available :', torch.cuda.is_available(), '| device:', (torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'))"
python -c "from doctr.models import ocr_predictor; m=ocr_predictor(pretrained=True); import torch; print('docTR device   :', next(m.det_predictor.model.parameters()).device)"
python -c "import docling; print('docling        : import OK')"
python tests/test_core.py 2>&1 | tail -1
set -e

echo "======================================================================"
echo " DONE. Every session, activate first:"
echo "     source $REPO/venv/bin/activate"
echo ""
echo " OPTIONAL - PaddleOCR (Chinese/non-sovereign; separate venv to avoid a"
echo " numpy-2 conflict with the rig):"
echo "     python3 -m venv ~/paddle-venv && source ~/paddle-venv/bin/activate"
echo "     pip install --upgrade pip && pip install paddlepaddle-gpu paddleocr"
echo "     # then run the comparison with THIS venv's python on scanned PDFs"
echo "======================================================================"
