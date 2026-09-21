# Local AI VPS security check

Run these commands from an external network observer or the Local AI VPS operator account. Do not expose credentials or internal response bodies.

```sh
# Public surface should be HTTPS only (80 may redirect).
nmap -Pn -p 80,443,4000,5000,11434 <LOCAL_AI_PUBLIC_IP>
curl -fsSIL https://ai.innoveraappcenter.com/ocr
openssl s_client -connect ai.innoveraappcenter.com:443 -servername ai.innoveraappcenter.com </dev/null 2>/dev/null | openssl x509 -noout -dates -issuer -subject
```

Expected public result: 443 reachable, optional 80 redirect, and ports 4000/5000/11434 filtered or closed. On the Local AI VPS verify listeners and firewall rules:

```sh
sudo ss -ltnp
sudo ufw status verbose                 # or: sudo firewall-cmd --list-all
sudo systemctl status nginx
sudo systemctl list-timers --all | grep -E 'certbot|renew' || true
```

Bind Ollama (11434), OCR FastAPI (5000), LiteLLM (4000), PostgreSQL, and internal queues to loopback/private interfaces only. Application VPS access must use `https://ai.innoveraappcenter.com/ocr`; never configure an internal AI address in `OCR_API_BASE_URL`.
