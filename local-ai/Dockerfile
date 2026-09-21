FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    paddlepaddle==3.2.0 \
    -i https://www.paddlepaddle.org.cn/packages/stable/cpu/

RUN pip install --no-cache-dir paddleocr

WORKDIR /app

CMD ["python", "-c", "import paddle; import paddleocr; print('PADDLE_OK', paddle.__version__)"]
