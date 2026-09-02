import sys
from pathlib import Path

# make the rig modules importable whether run via `pytest` from anywhere or standalone
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
