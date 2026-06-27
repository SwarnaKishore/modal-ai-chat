import subprocess

import modal


MODEL_NAME = "Qwen/Qwen2.5-7B-Instruct"
N_GPU = 1
VLLM_PORT = 8000
MINUTES = 60

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.21.0")
    .env(
        {
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_LOG_STATS_INTERVAL": "1",
        }
    )
)

hf_cache_vol = modal.Volume.from_name("qwen-huggingface-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("qwen-vllm-cache", create_if_missing=True)

app = modal.App("qwen-vllm")


@app.function(
    image=vllm_image,
    gpu=f"L4:{N_GPU}",
    scaledown_window=5 * MINUTES,
    timeout=15 * MINUTES,
    secrets=[modal.Secret.from_name("qwen-api-key")],
    volumes={
        "/root/.cache/huggingface": hf_cache_vol,
        "/root/.cache/vllm": vllm_cache_vol,
    },
)
@modal.concurrent(max_inputs=20)
@modal.web_server(port=VLLM_PORT, startup_timeout=15 * MINUTES)
def serve():
    import os

    api_key = os.environ["VLLM_API_KEY"]
    cmd = [
        "vllm",
        "serve",
        MODEL_NAME,
        "--served-model-name",
        MODEL_NAME,
        "--host",
        "0.0.0.0",
        "--port",
        str(VLLM_PORT),
        "--uvicorn-log-level=info",
        "--tensor-parallel-size",
        str(N_GPU),
        "--max-model-len",
        "8192",
        "--gpu-memory-utilization",
        "0.90",
        "--api-key",
        api_key,
    ]

    subprocess.Popen(cmd)


@app.local_entrypoint()
async def main():
    url = await serve.get_web_url.aio()
    print(f"Modal vLLM endpoint: {url}")
    print(f"Chat completions: {url}/v1/chat/completions")
