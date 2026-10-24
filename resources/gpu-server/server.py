"""ClearChat — servidor local de voz na GPU ("Modo avançado (GPU local)").

Roda com o Python do runtime baixado pelo app (`<userData>/gpu-runtime/`), nunca embutido no
pacote. Produto do laboratório `gpu-tts-lab/server.py` (ver SPEC.md → "Modo avançado (GPU local)").

Subcomandos
  serve           servidor HTTP OpenAI-compatível em 127.0.0.1 (porta e token por argumento/ambiente)
  download        baixa os pesos de UM motor (HF com revisão fixada + arquivos extras com sha256),
                  progresso em linhas JSON no stdout
  convert-voice   áudio de referência (wav/webm/ogg/mp3) → WAV 24 kHz mono PCM16 aparado; JSON no stdout
  check           importa os motores pedidos e informa o dispositivo (cuda/mps/cpu); JSON no stdout

Endpoints do `serve` (TODOS exigem `Authorization: Bearer <CLEARCHAT_GPU_TOKEN>`)
  GET  /health                 {"status":"ok", engines:{id:{state,error}}, busy, device}
  GET  /v1/models              motores servidos por este processo
  GET  /v1/voices              vozes por motor (embutidas + CC0 + do usuário)
  GET  /v1/capabilities        dispositivo/VRAM, idiomas, vozes, latência medida
  POST /v1/warmup              {"engines":[...]} carrega os modelos em segundo plano
  POST /v1/config              {"omnivoice":{"steps":16}}
  POST /v1/audio/speech        {model, input, voice, response_format: pcm|wav}
                               pcm e wav → corpo PCM16 em streaming (audio/pcm;rate=N;channels=1) — o
                               cliente do app decide pelo Content-Type; "wav_file" → WAV completo
  POST /v1/audio/transcriptions  multipart (file, model, language, response_format json|text|verbose_json)

Uma síntese por vez na GPU (espera ≤ 20 s → 503 "GPU ocupada"); OOM → 503 legível; desconexão do
cliente cancela a geração. Modelos carregam sob demanda (ou no /v1/warmup), descarregam depois de
`--idle-unload-s` sem uso e o processo sai sozinho depois de `--idle-exit-s` ocioso (o app sobe de
novo quando precisar).
"""


import argparse
import gc
import hashlib
import hmac
import io
import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import urllib.request
import wave
from pathlib import Path

PROTOCOL_VERSION = 1

# ---------------------------------------------------------------- catálogo (download/caminhos)
# Revisões fixadas (commit do HF) — o app nunca baixa "o que estiver no main". Os tamanhos e
# licenças vivem no catálogo do app (src/shared/gpuVoice.ts); aqui só o necessário para baixar e
# achar os arquivos.

VIBE_COMMIT = "16fb2cb1217c9934a886e1948ffb06120caa2df5"
VIBE_RAW = f"https://raw.githubusercontent.com/microsoft/VibeVoice/{VIBE_COMMIT}/demo/voices/streaming_model"

MODELS: dict[str, dict] = {
    "whisper-large-v3-turbo": {
        "hf": [{"repo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
                "revision": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
                "allow": ["config.json", "model.bin", "preprocessor_config.json", "tokenizer.json",
                          "vocabulary.json"]}],
    },
    "omnivoice": {
        "hf": [{"repo": "k2-fsa/OmniVoice", "revision": "c5fdb5ccb189668d56333f77ba2629f4cd7535f4",
                "ignore": ["README.md", ".gitattributes", "*/README.md", "*/.gitattributes"]}],
    },
    "xtts-v2": {
        "hf": [{"repo": "tts-hub/XTTS-v2", "revision": "345b56f6fbe25cca7103f7f34e471b8fe8e4945f",
                "allow": ["config.json", "model.pth", "speakers_xtts.pth", "vocab.json", "mel_stats.pth",
                          "LICENSE.txt"]}],
    },
    "vibevoice-realtime": {
        "hf": [{"repo": "microsoft/VibeVoice-Realtime-0.5B", "revision": "6bce5f06044837fe6d2c5d7a71a84f0416bd57e4",
                "allow": ["config.json", "model.safetensors", "preprocessor_config.json"]},
               {"repo": "Qwen/Qwen2.5-0.5B", "revision": "060db6499f32faf8b98477b0a26969ef7d8b9987",
                "allow": ["tokenizer.json", "tokenizer_config.json", "merges.txt", "vocab.json", "config.json",
                          "LICENSE"]}],
        "files": [
            {"url": f"{VIBE_RAW}/pt-Spk0_woman.pt", "dest": "vibevoice/pt-Spk0_woman.pt", "size": 2268290,
             "sha256": "40f3a231e011f9c5e1eb4e852599751ce749439edceb36d0fa2bca952387f5a9"},
            {"url": f"{VIBE_RAW}/pt-Spk1_man.pt", "dest": "vibevoice/pt-Spk1_man.pt", "size": 3554890,
             "sha256": "06a0052170a4ae5217931eb84318a6f86279439b536ad9780c724526d84148e5"},
        ],
    },
    "qwen3-tts-0.6b": {
        "hf": [{"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "revision": "5d83992436eae1d760afd27aff78a71d676296fc",
                "ignore": ["README.md", ".gitattributes"]}],
    },
    "qwen3-tts-1.7b": {
        "hf": [{"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "revision": "fd4b254389122332181a7c3db7f27e918eec64e3",
                "ignore": ["README.md", ".gitattributes"]}],
    },
}

TTS_IDS = ["omnivoice", "xtts-v2", "vibevoice-realtime", "qwen3-tts-0.6b", "qwen3-tts-1.7b"]
STT_ID = "whisper-large-v3-turbo"

OPENAI_VOICES = {"alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
                 "default"}
GPU_WAIT_S = 20.0


def hf_home() -> Path:
    return Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface"))


def repo_dir(repo: str) -> Path:
    return hf_home() / "hub" / ("models--" + repo.replace("/", "--"))


def snapshot_path(repo: str, revision: str) -> Path:
    return repo_dir(repo) / "snapshots" / revision


def model_path(engine: str, index: int = 0) -> Path:
    spec = MODELS[engine]["hf"][index]
    p = snapshot_path(spec["repo"], spec["revision"])
    if not p.is_dir():
        raise FileNotFoundError(f"pesos do motor '{engine}' não encontrados ({spec['repo']}) — instale o motor "
                                f"em Configurações → Áudio")
    return p


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------- dispositivo


def pick_device(torch) -> str:
    forced = os.environ.get("CLEARCHAT_GPU_DEVICE")
    if forced in ("cuda", "mps", "cpu"):
        return forced
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def setup_dll_paths() -> None:
    """Windows: as DLLs CUDA das wheels nvidia-* (cuBLAS/cuDNN do ctranslate2) entram no caminho."""
    if os.name != "nt":
        return
    try:
        import site

        for sp in site.getsitepackages():
            nv = Path(sp) / "nvidia"
            if nv.is_dir():
                for b in nv.glob("*/bin"):
                    os.add_dll_directory(str(b))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- download


def _matches(name: str, patterns: list[str] | None) -> bool:
    import fnmatch

    return any(fnmatch.fnmatch(name, p) for p in (patterns or []))


def _dir_bytes(d: Path) -> int:
    total = 0
    if not d.exists():
        return 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            try:
                p = Path(root) / f
                if not p.is_symlink():
                    total += p.stat().st_size
            except OSError:
                pass
    return total


def cmd_download(args) -> int:
    engine = args.engine
    if engine not in MODELS:
        emit({"event": "error", "message": f"motor desconhecido: {engine}"})
        return 2
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.pop("HF_HUB_OFFLINE", None)
    from huggingface_hub import HfApi, snapshot_download

    spec = MODELS[engine]
    api = HfApi()
    plan = []  # (repo spec, bytes previstos)
    total = 0
    for s in spec.get("hf", []):
        info = api.model_info(s["repo"], revision=s["revision"], files_metadata=True)
        size = 0
        for sib in info.siblings or []:
            name = sib.rfilename
            if s.get("allow") and not _matches(name, s["allow"]):
                continue
            if _matches(name, s.get("ignore")):
                continue
            size += int(sib.size or 0)
        plan.append((s, size))
        total += size
    for f in spec.get("files", []):
        total += int(f["size"])
    emit({"event": "plan", "total": total})

    done_before = 0
    for s, size in plan:
        blobs = repo_dir(s["repo"]) / "blobs"
        result: dict = {}

        def run(s=s, result=result):
            try:
                result["path"] = snapshot_download(
                    s["repo"], revision=s["revision"], allow_patterns=s.get("allow"),
                    ignore_patterns=s.get("ignore"), max_workers=4)
            except BaseException as e:  # noqa: BLE001
                result["error"] = e

        t = threading.Thread(target=run, daemon=True)
        t.start()
        last = -1
        while t.is_alive():
            t.join(0.5)
            # bytes já no cache deste repositório (inclui os .incomplete em andamento e o que uma
            # tentativa anterior deixou — o hub retoma de onde parou)
            cur = min(size, _dir_bytes(blobs))
            if cur != last:
                emit({"event": "progress", "bytes": done_before + cur, "total": total, "file": s["repo"]})
                last = cur
        if "error" in result:
            e = result["error"]
            emit({"event": "error", "message": f"falha ao baixar {s['repo']}: {type(e).__name__}: {e}"})
            return 1
        # refs/main → a revisão fixada: o carregamento offline por nome do repositório (ex.: o
        # tokenizer "Qwen/Qwen2.5-0.5B" do VibeVoice) acha o snapshot certo
        refs = repo_dir(s["repo"]) / "refs"
        refs.mkdir(parents=True, exist_ok=True)
        (refs / "main").write_text(s["revision"])
        done_before += size
        emit({"event": "progress", "bytes": done_before, "total": total, "file": s["repo"]})

    assets = Path(args.assets_dir)
    for f in spec.get("files", []):
        dest = assets / f["dest"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.stat().st_size == f["size"] and _sha256(dest) == f["sha256"]:
            done_before += f["size"]
            continue
        tmp = dest.with_name(dest.name + f".{os.getpid()}.part")
        h = hashlib.sha256()
        n = 0
        req = urllib.request.Request(f["url"], headers={"User-Agent": "ClearChat"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as out:
            while True:
                b = r.read(1 << 16)
                if not b:
                    break
                out.write(b)
                h.update(b)
                n += len(b)
                emit({"event": "progress", "bytes": done_before + n, "total": total, "file": f["dest"]})
        if n != f["size"] or h.hexdigest() != f["sha256"]:
            tmp.unlink(missing_ok=True)
            emit({"event": "error", "message": f"arquivo {f['dest']} com checksum divergente (esperado "
                                              f"{f['sha256'][:12]}…, veio {h.hexdigest()[:12]}…)"})
            return 1
        os.replace(tmp, dest)
        done_before += f["size"]
    emit({"event": "done", "bytes": done_before, "total": total,
          "repoDirs": [repo_dir(x["repo"]).name for x in spec.get("hf", [])],
          "assets": [f["dest"] for f in spec.get("files", [])]})
    return 0


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- áudio


def decode_to_mono(path_or_bytes, sr: int):
    """Decodifica qualquer formato que o PyAV/FFmpeg leia (wav/webm/ogg/mp3/m4a) → float32 mono em `sr`."""
    from faster_whisper.audio import decode_audio

    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else str(path_or_bytes)
    return decode_audio(src, sampling_rate=sr)


def trim_silence(x, sr: int, thresh: float = 0.01, pad_s: float = 0.12):
    import numpy as np

    a = np.abs(x)
    idx = np.where(a > thresh)[0]
    if not len(idx):
        return x
    pad = int(pad_s * sr)
    return x[max(0, idx[0] - pad): min(len(x), idx[-1] + pad)]


def pcm16(x) -> bytes:
    import numpy as np

    x = np.clip(np.asarray(x, dtype=np.float32).reshape(-1), -1.0, 1.0)
    return (x * 32767.0).astype("<i2").tobytes()


def wav_bytes(pcm: bytes, sr: int) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return b.getvalue()


def cmd_convert_voice(args) -> int:
    try:
        x = decode_to_mono(Path(args.input), 24000)
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "message": f"não consegui ler o áudio ({type(e).__name__}: {e})"})
        return 1
    x = trim_silence(x, 24000)
    dur = len(x) / 24000
    out = Path(args.output)
    tmp = out.with_name(out.name + f".{os.getpid()}.part")
    tmp.write_bytes(wav_bytes(pcm16(x), 24000))
    os.replace(tmp, out)
    emit({"ok": True, "durationS": round(dur, 2), "sampleRate": 24000})
    return 0


# ---------------------------------------------------------------- vozes


class Voices:
    """Vozes de clonagem em `<voices-dir>/<id>/` (voice.wav + meta.json; source.* convertido sob demanda)."""

    def __init__(self, root: Path | None):
        self.root = root

    def get(self, vid: str) -> dict | None:
        if not self.root or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", vid or ""):
            return None
        d = self.root / vid
        if not d.is_dir():
            return None
        meta = {}
        try:
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
        wav = d / "voice.wav"
        if not wav.exists():
            srcs = sorted(d.glob("source.*"))
            if not srcs:
                return None
            x = trim_silence(decode_to_mono(srcs[0], 24000), 24000)
            tmp = d / f"voice.wav.{os.getpid()}.part"
            tmp.write_bytes(wav_bytes(pcm16(x), 24000))
            os.replace(tmp, wav)
        text = (meta.get("transcript") or meta.get("transcriptAuto") or "").strip() or None
        return {"id": vid, "wav": str(wav), "text": text, "name": meta.get("name") or vid,
                "source": meta.get("source") or "user", "dir": d}

    def list(self) -> list[dict]:
        out = []
        if self.root and self.root.is_dir():
            for d in sorted(self.root.iterdir()):
                if d.is_dir():
                    v = None
                    try:
                        v = self.get(d.name)
                    except Exception:  # noqa: BLE001
                        v = None
                    if v:
                        out.append({"id": v["id"], "label": v["name"], "source": v["source"],
                                    "hasTranscript": bool(v["text"])})
        return out

    def save_auto_transcript(self, vid: str, text: str) -> None:
        d = self.root / vid if self.root else None
        if not d or not d.is_dir():
            return
        p = d / "meta.json"
        try:
            meta = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            meta = {}
        meta["transcriptAuto"] = text
        tmp = d / f"meta.json.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, p)


class Cancelled(Exception):
    pass


class VoiceError(Exception):
    pass


# ---------------------------------------------------------------- motores

SENT_SPLIT = re.compile(r"(?<=[.!?…;])\s+")


class Engine:
    id = "base"
    sr = 24000
    streaming = True
    languages = ["pt", "pt-BR"]
    needs_transcript = False
    clones = True

    def __init__(self, ctx: "Ctx"):
        self.ctx = ctx
        self._voice_cache: dict[str, object] = {}

    def builtin_voices(self) -> list[dict]:
        return []

    def default_voice(self) -> str | None:
        b = self.builtin_voices()
        if b:
            return b[0]["id"]
        if self.clones:
            for v in self.ctx.voices.list():
                if v["source"] == "cc0":
                    return v["id"]
            vs = self.ctx.voices.list()
            return vs[0]["id"] if vs else None
        return None

    def resolve_voice(self, voice: str | None) -> str:
        v = (voice or "").strip()
        if not v or v in OPENAI_VOICES:
            d = self.default_voice()
            if not d:
                raise VoiceError(f"nenhuma voz disponível para {self.id}: baixe a voz CC0 ou grave/envie a sua "
                                 f"em Configurações → Áudio")
            return d
        if any(b["id"] == v for b in self.builtin_voices()):
            return v
        if self.clones and self.ctx.voices.get(v):
            return v
        names = [b["id"] for b in self.builtin_voices()] + ([x["id"] for x in self.ctx.voices.list()]
                                                           if self.clones else [])
        raise VoiceError(f"voz '{v}' não existe para {self.id}; vozes: {', '.join(names) or 'nenhuma'}")

    def voice_state(self, vid: str):
        if vid not in self._voice_cache:
            builtin = next((b for b in self.builtin_voices() if b["id"] == vid), None)
            if builtin:
                self._voice_cache[vid] = self.prepare_builtin(builtin)
            else:
                v = self.ctx.voices.get(vid)
                if not v:
                    raise VoiceError(f"voz '{vid}' não encontrada")
                if self.needs_transcript and not v["text"]:
                    v["text"] = self.ctx.auto_transcript(v)
                self._voice_cache[vid] = self.prepare_voice(v)
        return self._voice_cache[vid]

    def prepare_builtin(self, b: dict):  # pragma: no cover
        raise NotImplementedError

    def prepare_voice(self, v: dict):  # pragma: no cover
        raise NotImplementedError

    def load(self):  # pragma: no cover
        raise NotImplementedError

    def unload(self):
        self._voice_cache.clear()
        for k in list(vars(self).keys()):
            if k not in ("ctx", "_voice_cache"):
                try:
                    delattr(self, k)
                except Exception:  # noqa: BLE001
                    pass

    def stream(self, text: str, voice: str, cancel: threading.Event):  # pragma: no cover
        raise NotImplementedError


XTTS_SPEAKERS = [
    ("xtts-ana-florence", "Ana Florence", "Ana Florence (estúdio, feminina)"),
    ("xtts-alma-maria", "Alma María", "Alma María (estúdio, feminina)"),
    ("xtts-claribel-dervla", "Claribel Dervla", "Claribel Dervla (estúdio, feminina)"),
    ("xtts-gilberto-mathias", "Gilberto Mathias", "Gilberto Mathias (estúdio, masculina)"),
    ("xtts-luis-moray", "Luis Moray", "Luis Moray (estúdio, masculina)"),
    ("xtts-marcos-rudaski", "Marcos Rudaski", "Marcos Rudaski (estúdio, masculina)"),
]


class XttsEngine(Engine):
    id = "xtts-v2"

    def builtin_voices(self):
        return [{"id": i, "label": label, "speaker": spk, "accent": "other"} for i, spk, label in XTTS_SPEAKERS]

    def default_voice(self):
        # CC0 brasileira primeiro (o estúdio do XTTS não é pt-BR)
        for v in self.ctx.voices.list():
            if v["source"] == "cc0":
                return v["id"]
        return super().default_voice()

    def load(self):
        import torch
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts

        self.torch = torch
        d = model_path(self.id)
        cfg = XttsConfig()
        cfg.load_json(str(d / "config.json"))
        m = Xtts.init_from_config(cfg)
        m.load_checkpoint(cfg, checkpoint_dir=str(d), eval=True, use_deepspeed=False)
        self.model = m.to(self.ctx.device)
        self.sr = int(cfg.audio.output_sample_rate)

    def prepare_builtin(self, b):
        spk = self.model.speaker_manager.speakers[b["speaker"]]
        return spk["gpt_cond_latent"].to(self.ctx.device), spk["speaker_embedding"].to(self.ctx.device)

    def prepare_voice(self, v):
        return self.model.get_conditioning_latents(audio_path=[v["wav"]])

    @staticmethod
    def clean(text: str) -> str:
        # XTTS em pt às vezes FALA o ponto final ("…agora, ponto"): 5/24 com ponto, 0/24 sem (lab)
        t = re.sub(r"\s+", " ", text).strip()
        return re.sub(r"[.]+$", "", t).strip() or t

    def stream(self, text, voice, cancel):
        gpt, spk = self.voice_state(voice)
        # frase a frase (limite de ~203 caracteres do XTTS em pt; e tira o ponto final de cada uma)
        parts = [p for p in SENT_SPLIT.split(re.sub(r"\s+", " ", text).strip()) if p]
        for part in parts:
            with self.torch.inference_mode():
                gen = self.model.inference_stream(self.clean(part), "pt", gpt, spk, stream_chunk_size=20,
                                                  enable_text_splitting=False)
                try:
                    for c in gen:
                        if cancel.is_set():
                            raise Cancelled()
                        yield c.float().cpu().numpy()
                finally:
                    gen.close()


FRAME = 1920  # amostras por quadro do Qwen3-TTS-12Hz a 24 kHz


class QwenEngine(Engine):
    needs_transcript = True

    def __init__(self, ctx, eid: str):
        super().__init__(ctx)
        self.id = eid
        self.first_frames, self.chunk_frames, self.ctx_frames = 4, 10, 25
        self._q: queue.Queue | None = None
        self._cancel: threading.Event | None = None

    def load(self):
        import functools

        import torch
        from qwen_tts import Qwen3TTSModel

        self.torch = torch
        dev = self.ctx.device
        dtype = torch.bfloat16 if dev == "cuda" else (torch.float16 if dev == "mps" else torch.float32)
        self.qm = Qwen3TTSModel.from_pretrained(str(model_path(self.id)),
                                                device_map=("cuda:0" if dev == "cuda" else dev), dtype=dtype,
                                                attn_implementation="sdpa")
        self.model = self.qm.model
        self.decoder = self.model.speech_tokenizer.model.decoder
        self.upsample = int(self.decoder.total_upsample)
        self.eos = self.model.config.talker_config.codec_eos_token_id
        talker = self.model.talker
        orig = talker.forward

        # streaming feito no lab: captura cada quadro de códigos assim que o talker o gera
        @functools.wraps(orig)
        def fwd(*a, **k):
            if self._cancel is not None and self._cancel.is_set():
                raise Cancelled()
            out = orig(*a, **k)
            q = self._q
            cid = out.hidden_states[1]
            if q is not None and cid is not None:
                q.put(cid[0].detach().clone())
            return out

        talker.forward = fwd

    def prepare_voice(self, v):
        qm = self.qm
        items = qm.create_voice_clone_prompt(ref_audio=v["wav"], ref_text=v["text"])
        ref_ids = [qm._tokenize_texts([qm._build_ref_text(v["text"])])[0]]
        return items, items[0].ref_code.to(self.model.device), ref_ids

    def _decode(self, frames, start, end, ref_code):
        torch = self.torch
        cur = torch.stack(frames[max(0, start - self.ctx_frames):end])
        ctx = min(start, self.ctx_frames)
        if ctx < self.ctx_frames and ref_code is not None:
            need = self.ctx_frames - ctx
            pre = ref_code[-need:]
            cur = torch.cat([pre, cur], 0)
            ctx += pre.shape[0]
        codes = torch.clamp(cur, min=0).T.unsqueeze(0).long()
        wav = self.decoder(codes)[0, 0]
        return wav[ctx * self.upsample:].float().cpu().numpy()

    def stream(self, text, voice, cancel):
        torch = self.torch
        prompt, ref_code, ref_ids = self.voice_state(voice)
        qm = self.qm
        input_ids = qm._tokenize_texts([qm._build_assistant_text(text)])
        # teto de quadros proporcional ao texto: o 1.7B entrou em laço sem EOS (655 s de áudio
        # para 250 caracteres) numa das 15 sínteses do lab. ~12 caracteres/s; 3x de folga + 3 s.
        cap = int(12.5 * (len(text) / 12.0 * 3.0 + 3.0))
        kw = dict(input_ids=input_ids, languages=["portuguese"], non_streaming_mode=False,
                  voice_clone_prompt=qm._prompt_items_to_voice_clone_prompt(prompt), ref_ids=ref_ids,
                  **qm._merge_generate_kwargs(max_new_tokens=cap))
        q: queue.Queue = queue.Queue()
        err: list[BaseException] = []

        def run():
            try:
                with torch.inference_mode():
                    self.model.generate(**kw)
            except BaseException as e:  # noqa: BLE001
                err.append(e)
            finally:
                q.put(None)

        self._q = q
        self._cancel = cancel
        t = threading.Thread(target=run, daemon=True)
        t.start()
        frames: list = []
        emitted = 0
        finished = False
        try:
            with torch.inference_mode():
                while not finished:
                    item = q.get()
                    if cancel.is_set():
                        raise Cancelled()
                    if item is None:
                        finished = True
                    elif int(item[0]) == self.eos:
                        finished = True
                    else:
                        frames.append(item)
                    while not finished:
                        try:
                            nxt = q.get_nowait()
                        except queue.Empty:
                            break
                        if nxt is None or int(nxt[0]) == self.eos:
                            finished = True
                            break
                        frames.append(nxt)
                    target = self.first_frames if emitted == 0 else self.chunk_frames
                    if len(frames) - emitted >= target or (finished and len(frames) > emitted):
                        end = len(frames)
                        yield self._decode(frames, emitted, end, ref_code)
                        emitted = end
        finally:
            if not finished:
                cancel.set()  # consumidor saiu no meio (barge-in): o talker para no próximo quadro
            t.join()
            self._q = None
            self._cancel = None
        if err and not isinstance(err[0], Cancelled):
            raise err[0]


OMNI_DESIGNS = [
    ("omni-feminina", "Feminina (desenho de voz do OmniVoice)", "female, young adult, moderate pitch"),
    ("omni-masculina", "Masculina (desenho de voz do OmniVoice)", "male, middle-aged, low pitch"),
]
OMNI_DESIGN_TEXT = ("Olá! Esta é a minha voz. Posso te ajudar com o que você precisar hoje, é só pedir com "
                    "calma que eu explico tudo.")


class OmniEngine(Engine):
    id = "omnivoice"
    streaming = False
    needs_transcript = True

    def builtin_voices(self):
        return [{"id": i, "label": label, "instruct": ins} for i, label, ins in OMNI_DESIGNS]

    def default_voice(self):
        for v in self.ctx.voices.list():
            if v["source"] == "cc0":
                return v["id"]
        return super().default_voice()

    def load(self):
        import torch
        from omnivoice import OmniVoice

        self.torch = torch
        dev = self.ctx.device
        dtype = torch.float16 if dev in ("cuda", "mps") else torch.float32
        self.m = OmniVoice.from_pretrained(str(model_path(self.id)), device_map=("cuda:0" if dev == "cuda" else dev),
                                           dtype=dtype)
        self.sr = int(getattr(self.m, "sampling_rate", 24000) or 24000)

    def prepare_builtin(self, b):
        # desenho de voz → uma referência fixa (semente fixa) → clonagem: a voz não muda de frase
        # para frase (o modo "design" puro sorteia um timbre a cada geração)
        cache = self.ctx.assets / "omnivoice" / f"{b['id']}.wav"
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            self.torch.manual_seed(1234)
            with self.torch.inference_mode():
                out = self.m.generate(text=OMNI_DESIGN_TEXT, language="pt", instruct=b["instruct"], num_step=32)
            tmp = cache.with_name(cache.name + f".{os.getpid()}.part")
            tmp.write_bytes(wav_bytes(pcm16(out[0]), self.sr))
            os.replace(tmp, cache)
        return self.m.create_voice_clone_prompt(ref_audio=str(cache), ref_text=OMNI_DESIGN_TEXT)

    def prepare_voice(self, v):
        return self.m.create_voice_clone_prompt(ref_audio=v["wav"], ref_text=v["text"])

    def stream(self, text, voice, cancel):
        prompt = self.voice_state(voice)
        # sem streaming: frase a frase (a 1ª frase sai antes das demais)
        parts = [p for p in re.split(r"(?<=[.!?…])\s+", text.strip()) if p]
        for p in parts:
            if cancel.is_set():
                raise Cancelled()
            with self.torch.inference_mode():
                out = self.m.generate(text=p, language="pt", voice_clone_prompt=prompt,
                                      num_step=int(self.ctx.config["omnivoice"]["steps"]))
            yield out[0]


VIBE_VOICES = [
    ("vibe-pt-woman", "pt-Spk0_woman", "Mulher (embutida, pt)"),
    ("vibe-pt-man", "pt-Spk1_man", "Homem (embutida, pt)"),
]


class VibeEngine(Engine):
    id = "vibevoice-realtime"
    clones = False

    def builtin_voices(self):
        return [{"id": i, "label": label, "file": f} for i, f, label in VIBE_VOICES]

    def load(self):
        import torch
        from vibevoice.modular.modeling_vibevoice_streaming_inference import (
            VibeVoiceStreamingForConditionalGenerationInference,
        )
        from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor

        self.torch = torch
        dev = self.ctx.device
        mp = str(model_path(self.id))
        self.proc = VibeVoiceStreamingProcessor.from_pretrained(mp)
        dtype = torch.bfloat16 if dev == "cuda" else torch.float32
        self.model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            mp, torch_dtype=dtype, device_map=dev, attn_implementation="sdpa")
        self.model.eval()
        self.model.set_ddpm_inference_steps(num_steps=5)

    def prepare_builtin(self, b):
        from transformers.cache_utils import DynamicCache
        from transformers.modeling_outputs import BaseModelOutputWithPast

        p = self.ctx.assets / "vibevoice" / f"{b['file']}.pt"
        if not p.exists():
            raise VoiceError(f"voz embutida {b['file']} não instalada (reinstale o VibeVoice)")
        with self.torch.serialization.safe_globals([BaseModelOutputWithPast, DynamicCache]):
            return self.torch.load(str(p), map_location=self.ctx.device, weights_only=True)

    def stream(self, text, voice, cancel):
        import copy

        from vibevoice.modular.streamer import AudioStreamer

        torch = self.torch
        prefilled = self.voice_state(voice)
        inputs = self.proc.process_input_with_cached_prompt(text=text, cached_prompt=prefilled, padding=True,
                                                            return_tensors="pt", return_attention_mask=True)
        inputs = {k: (v.to(self.ctx.device) if torch.is_tensor(v) else v) for k, v in inputs.items()}
        st = AudioStreamer(batch_size=1, stop_signal=None, timeout=None)
        errs: list = []

        def run():
            try:
                with torch.inference_mode():
                    self.model.generate(**inputs, max_new_tokens=None, cfg_scale=1.5,
                                        tokenizer=self.proc.tokenizer, generation_config={"do_sample": False},
                                        audio_streamer=st, stop_check_fn=cancel.is_set, verbose=False,
                                        all_prefilled_outputs=copy.deepcopy(prefilled))
            except Exception as e:  # noqa: BLE001
                errs.append(e)
                st.end()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        try:
            for c in st.get_stream(0):
                if cancel.is_set():
                    raise Cancelled()
                yield c.detach().float().cpu().numpy().reshape(-1)
        finally:
            cancel.set()
            st.end()
            t.join()
        if errs:
            raise errs[0]


def make_engine(ctx: "Ctx", eid: str) -> Engine:
    if eid == "xtts-v2":
        return XttsEngine(ctx)
    if eid in ("qwen3-tts-0.6b", "qwen3-tts-1.7b"):
        return QwenEngine(ctx, eid)
    if eid == "omnivoice":
        return OmniEngine(ctx)
    if eid == "vibevoice-realtime":
        return VibeEngine(ctx)
    raise ValueError(f"motor desconhecido: {eid}")


# ---------------------------------------------------------------- contexto do servidor


class Slot:
    """Motor (TTS ou o STT) com carga preguiçosa e estado legível."""

    def __init__(self, eid: str, kind: str):
        self.id, self.kind = eid, kind
        self.obj = None
        self.state = "idle"  # idle | loading | ready | error
        self.error: str | None = None
        self.last_used = time.time()
        self.lock = threading.Lock()
        self.load_s: float | None = None
        self.first_audio_ms: float | None = None


class Ctx:
    def __init__(self, args):
        self.args = args
        self.token = os.environ.get("CLEARCHAT_GPU_TOKEN") or ""
        self.voices = Voices(Path(args.voices_dir) if args.voices_dir else None)
        self.assets = Path(args.assets_dir)
        self.config = {"omnivoice": {"steps": max(4, min(64, int(args.omni_steps)))}}
        self.slots: dict[str, Slot] = {}
        for eid in [e for e in args.engines.split(",") if e]:
            self.slots[eid] = Slot(eid, "stt" if eid == STT_ID else "tts")
        self.gpu_lock = threading.Lock()
        self.stt_lock = threading.Lock()
        self.busy = False
        self.last_request = time.time()
        self.torch = None
        self.device = "cpu"

    def init_torch(self):
        import torch

        self.torch = torch
        self.device = pick_device(torch)

    # ---- carga
    def ensure(self, eid: str) -> Slot:
        s = self.slots.get(eid)
        if s is None:
            raise KeyError(eid)
        s.last_used = time.time()
        if s.state == "ready":
            return s
        with s.lock:
            if s.state == "ready":
                return s
            s.state, s.error = "loading", None
            t0 = time.perf_counter()
            try:
                if s.kind == "stt":
                    s.obj = self._load_whisper()
                else:
                    eng = make_engine(self, eid)
                    eng.load()
                    s.obj = eng
                s.state = "ready"
                s.load_s = round(time.perf_counter() - t0, 1)
                log(f"{eid} carregado em {s.load_s}s ({self.device})")
            except BaseException as e:  # noqa: BLE001
                s.state = "error"
                s.error = friendly_error(e)
                s.obj = None
                log(f"falha ao carregar {eid}: {type(e).__name__}: {e}")
                self.free_memory()
                raise
        return s

    def _load_whisper(self):
        from faster_whisper import WhisperModel

        dev = "cuda" if self.device == "cuda" else "cpu"
        compute = "int8_float16" if dev == "cuda" else "int8"
        return WhisperModel(str(model_path(STT_ID)), device=dev, compute_type=compute)

    def unload(self, eid: str):
        s = self.slots.get(eid)
        if not s or s.state != "ready":
            return
        with s.lock:
            obj, s.obj = s.obj, None
            s.state = "idle"
            if isinstance(obj, Engine):
                obj.unload()
            del obj
            self.free_memory()
            log(f"{eid} descarregado (ocioso)")

    def free_memory(self):
        gc.collect()
        try:
            if self.torch is not None and self.torch.cuda.is_available():
                self.torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass

    def auto_transcript(self, v: dict) -> str:
        """Transcrição da voz de referência pelo whisper deste runtime (clonagem ICL precisa do texto)."""
        if STT_ID not in self.slots:
            try:
                model_path(STT_ID)
            except FileNotFoundError:
                raise VoiceError(f"a voz '{v['name']}' não tem transcrição — digite o texto falado ao adicionar a "
                                 f"voz, ou instale o whisper-large-v3-turbo para transcrever sozinho") from None
            self.slots[STT_ID] = Slot(STT_ID, "stt")
        s = self.ensure(STT_ID)
        with self.stt_lock:
            segs, _info = s.obj.transcribe(v["wav"], language="pt", beam_size=5, vad_filter=False,
                                           condition_on_previous_text=False)
            text = " ".join(x.text.strip() for x in segs).strip()
        if not text:
            raise VoiceError(f"não consegui transcrever a voz '{v['name']}' (áudio sem fala?)")
        self.voices.save_auto_transcript(v["id"], text)
        return text

    def gpu_info(self) -> dict:
        info: dict = {"device": self.device}
        torch = self.torch
        try:
            if torch is not None:
                info["torch"] = torch.__version__
                info["cuda_runtime"] = torch.version.cuda
                if torch.cuda.is_available():
                    info["name"] = torch.cuda.get_device_name(0)
                    free, total = torch.cuda.mem_get_info(0)
                    info["vram_total_mb"] = round(total / 2**20)
                    info["vram_free_mb"] = round(free / 2**20)
                    info["torch_allocated_mb"] = round(torch.cuda.memory_allocated(0) / 2**20)
        except Exception as e:  # noqa: BLE001
            info["error"] = str(e)
        try:
            import pynvml

            pynvml.nvmlInit()
            h = pynvml.nvmlDeviceGetHandleByIndex(0)
            info["driver"] = pynvml.nvmlSystemGetDriverVersion()
            for p in pynvml.nvmlDeviceGetComputeRunningProcesses(h):
                if p.pid == os.getpid() and p.usedGpuMemory:
                    info["process_vram_mb"] = round(p.usedGpuMemory / 2**20)
            info["gpu_util_pct"] = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
        except Exception:  # noqa: BLE001
            pass
        return info


def friendly_error(e: BaseException) -> str:
    msg = f"{type(e).__name__}: {e}"
    low = msg.lower()
    if "out of memory" in low:
        return "GPU sem memória (VRAM) para carregar o modelo — feche outros programas que usam a GPU ou use um " \
               "motor menor"
    if isinstance(e, FileNotFoundError):
        return str(e)
    return msg[:400]


def log(msg: str) -> None:
    sys.stderr.write(f"[gpu-server] {msg}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- jobs de síntese


class Job:
    """Síntese numa thread (com a trava da GPU); pedaços float32 numa fila; cancelável."""

    def __init__(self, ctx: Ctx, eng: Engine, text: str, voice: str):
        self.ctx, self.eng, self.text, self.voice = ctx, eng, text, voice
        self.q: queue.Queue = queue.Queue()
        self.cancel = threading.Event()
        self.t0 = time.perf_counter()
        self.first_ms: float | None = None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        if not self.ctx.gpu_lock.acquire(timeout=GPU_WAIT_S):
            self.q.put(("error", ("busy", f"GPU ocupada há mais de {GPU_WAIT_S:.0f} s (outra síntese em andamento)")))
            return
        self.ctx.busy = True
        try:
            for c in self.eng.stream(self.text, self.voice, self.cancel):
                if self.first_ms is None:
                    self.first_ms = (time.perf_counter() - self.t0) * 1000
                self.q.put(("chunk", c))
                if self.cancel.is_set():
                    break
            self.q.put(("end", None))
        except Cancelled:
            self.q.put(("end", None))
        except VoiceError as e:
            self.q.put(("error", ("voice", str(e))))
        except Exception as e:  # noqa: BLE001
            low = str(e).lower()
            kind = "oom" if "out of memory" in low else "internal"
            if kind == "oom":
                self.ctx.free_memory()
            log(f"síntese falhou ({self.eng.id}): {type(e).__name__}: {e}")
            self.q.put(("error", (kind, f"{type(e).__name__}: {e}")))
        finally:
            self.ctx.busy = False
            self.ctx.gpu_lock.release()

    def next(self):
        return self.q.get()


# ---------------------------------------------------------------- app HTTP


def build_app(ctx: Ctx):
    from fastapi import FastAPI, File, Form, Request, UploadFile
    from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
    from starlette.concurrency import run_in_threadpool

    app = FastAPI(title="ClearChat GPU voice", docs_url=None, redoc_url=None, openapi_url=None)

    def err(status: int, msg: str, code: str = "error") -> JSONResponse:
        return JSONResponse({"error": {"message": msg, "type": code}}, status_code=status)

    @app.middleware("http")
    async def auth(request: Request, call_next):
        got = request.headers.get("authorization", "")
        want = f"Bearer {ctx.token}"
        if not ctx.token or not hmac.compare_digest(got.encode(), want.encode()):
            return err(401, "token inválido", "auth")
        ctx.last_request = time.time()
        return await call_next(request)

    def engine_states() -> dict:
        return {k: {"state": s.state, "error": s.error, "kind": s.kind, "loadS": s.load_s}
                for k, s in ctx.slots.items()}

    @app.get("/health")
    def health():
        return {"status": "ok", "protocol": PROTOCOL_VERSION, "pid": os.getpid(), "device": ctx.device,
                "busy": ctx.busy, "engines": engine_states()}

    @app.get("/v1/models")
    def models():
        data = [{"id": k, "object": "model", "owned_by": "clearchat-gpu", "type": s.kind} for k, s in ctx.slots.items()]
        return {"object": "list", "data": data}

    def voices_for(eid: str) -> list[dict]:
        out = []
        tmp = make_engine(ctx, eid)
        for b in tmp.builtin_voices():
            out.append({"id": b["id"], "label": b["label"], "source": "builtin"})
        if tmp.clones:
            out += ctx.voices.list()
        return out

    @app.get("/v1/voices")
    def voices():
        return {"voices": {k: voices_for(k) for k, s in ctx.slots.items() if s.kind == "tts"}}

    @app.get("/v1/capabilities")
    def capabilities():
        return {
            "protocol": PROTOCOL_VERSION,
            "busy": ctx.busy,
            "gpu": ctx.gpu_info(),
            "engines": engine_states(),
            "tts": [{"id": k, "languages": ["pt", "pt-BR"], "formats": ["pcm", "wav", "wav_file"],
                     "firstAudioMs": s.first_audio_ms, "voices": voices_for(k)}
                    for k, s in ctx.slots.items() if s.kind == "tts"],
            "stt": [k for k, s in ctx.slots.items() if s.kind == "stt"],
            "config": ctx.config,
        }

    @app.post("/v1/warmup")
    async def warmup(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        ids = [e for e in (body.get("engines") or list(ctx.slots)) if e in ctx.slots]
        voices = body.get("voices") or {}

        def run():
            for e in ids:
                try:
                    slot = ctx.ensure(e)
                    # síntese curta com a voz escolhida: prepara a voz (conversão, prompt de
                    # clonagem) e aquece os kernels — a 1ª fala da chamada não paga isso
                    if body.get("synth") and slot.kind == "tts":
                        eng: Engine = slot.obj
                        job = Job(ctx, eng, "Olá.", eng.resolve_voice(voices.get(e)))
                        while job.next()[0] == "chunk":
                            pass
                except BaseException as ex:  # noqa: BLE001
                    log(f"aquecimento de {e} falhou: {type(ex).__name__}: {ex}")

        if body.get("wait"):
            await run_in_threadpool(run)
        else:
            threading.Thread(target=run, daemon=True).start()
        return {"engines": engine_states()}

    @app.post("/v1/config")
    async def config(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return err(400, "corpo JSON inválido")
        omni = body.get("omnivoice") or {}
        if "steps" in omni:
            try:
                ctx.config["omnivoice"]["steps"] = max(4, min(64, int(omni["steps"])))
            except (TypeError, ValueError):
                return err(400, "omnivoice.steps inválido")
        return {"config": ctx.config}

    @app.post("/v1/audio/speech")
    async def speech(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return err(400, "corpo JSON inválido")
        text = str(body.get("input") or "").strip()
        if not text:
            return err(400, "campo 'input' vazio")
        model = str(body.get("model") or "").strip()
        tts = [k for k, s in ctx.slots.items() if s.kind == "tts"]
        if not model and tts:
            model = tts[0]
        slot = ctx.slots.get(model)
        if slot is None or slot.kind != "tts":
            return err(404, f"modelo '{model}' não é servido por este processo; disponíveis: {', '.join(tts) or '—'}",
                       "model_not_found")
        fmt = str(body.get("response_format") or "wav").lower()
        if fmt not in ("pcm", "wav", "wav_file"):
            return err(400, f"response_format '{fmt}' não suportado: expected one of wav|pcm")
        try:
            await run_in_threadpool(ctx.ensure, model)
        except BaseException:  # noqa: BLE001
            return err(503, f"o motor {model} não carregou: {slot.error}", "load_failed")
        eng: Engine = slot.obj
        try:
            voice = eng.resolve_voice(body.get("voice"))
        except VoiceError as e:
            return err(400, str(e), "voice_not_found")
        job = Job(ctx, eng, text, voice)
        kind, payload = await run_in_threadpool(job.next)
        if kind == "error":
            k, msg = payload
            status = {"busy": 503, "oom": 503, "voice": 400}.get(k, 500)
            return err(status, ("GPU sem memória: " if k == "oom" else "") + msg, k)
        if kind == "end":
            return err(500, "síntese não produziu áudio")
        slot.first_audio_ms = job.first_ms
        slot.last_used = time.time()
        hdr = {"X-First-Audio-Ms": f"{job.first_ms or 0:.0f}", "X-Model": eng.id, "X-Voice": voice,
               "Cache-Control": "no-store"}
        first = payload
        if fmt in ("pcm", "wav"):
            async def gen():
                try:
                    yield pcm16(first)
                    while True:
                        k, p = await run_in_threadpool(job.next)
                        if k == "chunk":
                            yield pcm16(p)
                        else:
                            break  # erro no meio do stream: encerra o corpo (o cabeçalho já saiu)
                finally:
                    job.cancel.set()

            return StreamingResponse(gen(), media_type=f"audio/pcm;rate={eng.sr};channels=1", headers=hdr)
        parts = [pcm16(first)]
        while True:
            k, p = await run_in_threadpool(job.next)
            if k == "chunk":
                parts.append(pcm16(p))
            elif k == "error":
                return err(500, p[1], p[0])
            else:
                break
        return Response(wav_bytes(b"".join(parts), eng.sr), media_type="audio/wav", headers=hdr)

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(file: UploadFile = File(...), model: str = Form(None), language: str = Form(None),
                             response_format: str = Form("json"), prompt: str = Form(None)):
        slot = ctx.slots.get(STT_ID)
        if slot is None:
            return err(404, "transcrição não habilitada neste processo", "model_not_found")
        data = await file.read()
        if not data:
            return err(400, "arquivo de áudio vazio")
        lang = (language or "").split("-")[0].lower() or None

        def run():
            s = ctx.ensure(STT_ID)
            audio = decode_to_mono(data, 16000)
            t0 = time.perf_counter()
            with ctx.stt_lock:
                segs, info = s.obj.transcribe(audio, language=lang, beam_size=1, vad_filter=False,
                                              condition_on_previous_text=False, initial_prompt=prompt or None)
                segs = list(segs)
            s.last_used = time.time()
            return segs, info, (time.perf_counter() - t0) * 1000, len(audio) / 16000

        try:
            segs, info, ms, dur = await run_in_threadpool(run)
        except Exception as e:  # noqa: BLE001
            if "out of memory" in str(e).lower():
                ctx.free_memory()
                return err(503, f"GPU sem memória: {e}", "oom")
            if slot.state == "error":
                return err(503, f"o whisper não carregou: {slot.error}", "load_failed")
            return err(400 if "Invalid data" in str(e) else 500, f"{type(e).__name__}: {e}")
        text = " ".join(s.text.strip() for s in segs).strip()
        hdr = {"X-Stt-Ms": f"{ms:.0f}"}
        if response_format == "text":
            return PlainTextResponse(text, headers=hdr)
        if response_format == "verbose_json":
            return JSONResponse({"text": text, "language": info.language, "duration": dur,
                                 "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in segs]},
                                headers=hdr)
        return JSONResponse({"text": text}, headers=hdr)

    return app


def idle_monitor(ctx: Ctx):
    unload_s = max(30, int(ctx.args.idle_unload_s))
    exit_s = int(ctx.args.idle_exit_s)
    parent = os.getppid()
    while True:
        time.sleep(5)
        now = time.time()
        # pai morreu (app fechou sem conseguir nos derrubar): sai também
        if os.name != "nt" and os.getppid() != parent:
            log("processo pai encerrado — saindo")
            os._exit(0)
        for eid, s in list(ctx.slots.items()):
            if s.state == "ready" and now - s.last_used > unload_s and not ctx.busy:
                ctx.unload(eid)
        if exit_s > 0 and now - ctx.last_request > exit_s and not ctx.busy:
            emit({"event": "idle-exit"})
            log(f"ocioso há {exit_s}s — saindo para devolver a memória")
            os._exit(0)


def cmd_serve(args) -> int:
    os.environ["HF_HUB_OFFLINE"] = "1"  # nada de download escondido: tudo vem do "Instalar"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    ctx = Ctx(args)
    if not ctx.token:
        log("CLEARCHAT_GPU_TOKEN ausente — recusando subir sem autenticação")
        return 2
    setup_dll_paths()
    ctx.init_torch()  # torch antes do faster-whisper: carrega cuBLAS/cuDNN das wheels nvidia-*
    import uvicorn

    app = build_app(ctx)
    threading.Thread(target=idle_monitor, args=(ctx,), daemon=True).start()
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    emit({"event": "listening", "port": args.port, "device": ctx.device, "pid": os.getpid()})
    server.run()
    return 0


def cmd_check(args) -> int:
    out: dict = {"ok": True, "python": sys.version.split()[0], "engines": {}}
    try:
        setup_dll_paths()
        import torch

        out["torch"] = torch.__version__
        out["cudaRuntime"] = torch.version.cuda
        out["cuda"] = bool(torch.cuda.is_available())
        out["device"] = pick_device(torch)
        if out["cuda"]:
            out["gpu"] = torch.cuda.get_device_name(0)
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "message": f"torch não carrega: {type(e).__name__}: {e}"})
        return 1
    mods = {"whisper-large-v3-turbo": "faster_whisper", "xtts-v2": "TTS.tts.models.xtts", "omnivoice": "omnivoice",
            "qwen3-tts-0.6b": "qwen_tts", "qwen3-tts-1.7b": "qwen_tts",
            "vibevoice-realtime": "vibevoice.modular.modeling_vibevoice_streaming_inference"}
    import importlib

    for e in [x for x in (args.engines or "").split(",") if x]:
        try:
            importlib.import_module(mods[e])
            out["engines"][e] = {"ok": True}
        except Exception as ex:  # noqa: BLE001
            out["ok"] = False
            out["engines"][e] = {"ok": False, "message": f"{type(ex).__name__}: {ex}"[:400]}
    emit(out)
    return 0 if out["ok"] else 1


def main() -> int:
    ap = argparse.ArgumentParser(prog="clearchat-gpu-server")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, required=True)
    s.add_argument("--engines", required=True, help="ids separados por vírgula (TTS e/ou whisper-large-v3-turbo)")
    s.add_argument("--voices-dir", default=None)
    s.add_argument("--assets-dir", required=True)
    s.add_argument("--omni-steps", type=int, default=16)
    s.add_argument("--idle-unload-s", type=int, default=600)
    s.add_argument("--idle-exit-s", type=int, default=900)
    d = sub.add_parser("download")
    d.add_argument("--engine", required=True)
    d.add_argument("--assets-dir", required=True)
    c = sub.add_parser("convert-voice")
    c.add_argument("input")
    c.add_argument("output")
    k = sub.add_parser("check")
    k.add_argument("--engines", default="")
    args = ap.parse_args()
    if args.cmd == "serve":
        if args.host not in ("127.0.0.1", "localhost", "::1"):
            log("só escuta em 127.0.0.1")
            return 2
        return cmd_serve(args)
    if args.cmd == "download":
        return cmd_download(args)
    if args.cmd == "convert-voice":
        return cmd_convert_voice(args)
    if args.cmd == "check":
        return cmd_check(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
