# PyInstaller runtime hook: LeRobot's motor code imports torch only for type hints, so the frozen
# sidecar ships this stand-in instead of PyTorch (~300 MB). Any real use fails loudly.
import sys
import types

torch = types.ModuleType("torch")
torch.Tensor = type("Tensor", (), {})
torch.device = type("device", (), {})
torch.dtype = type("dtype", (), {})
torch.bfloat16 = torch.dtype()


def _missing(name: str):
    raise AttributeError(f"torch.{name} is not available in Pivot's bundled sidecar")


torch.__getattr__ = _missing
sys.modules["torch"] = torch
