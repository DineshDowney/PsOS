# VM deployment (`psos-1`, asia-south1-a)

Everything the VM needs that is *not* application code. Kept in the repo because
these files were previously typed straight onto the box, which meant a rebuilt VM
would have silently lost them.

## Units on the VM

| Unit | Source | What it does |
|---|---|---|
| `psos.service` | (on VM) | `npm start` as `DineshGarg`, `EnvironmentFile=-/etc/psos.env` |
| `psos.service.d/runtime-dir.conf` | `psos-runtime-dir.conf` | creates `/run/psos` owned by the app user |
| `psos-autostop.service` | (on VM) | `shutdown -h +60` at boot — the backstop |
| `psos-keepalive.timer` + `.service` | here | every 30 min, run the check below |
| `/usr/local/bin/psos-keepalive-check` | `psos-keepalive-check` | cancel or arm the poweroff |

## Install / update

```bash
# from the laptop
gcloud compute scp deploy/vm/* psos-1:/tmp/ --project=<proj> --zone=asia-south1-a

# on the VM
sudo install -m 0755 /tmp/psos-keepalive-check /usr/local/bin/psos-keepalive-check
sudo install -m 0644 /tmp/psos-keepalive.service /tmp/psos-keepalive.timer /etc/systemd/system/
sudo mkdir -p /etc/systemd/system/psos.service.d
sudo install -m 0644 /tmp/psos-runtime-dir.conf /etc/systemd/system/psos.service.d/runtime-dir.conf
sudo systemctl daemon-reload
sudo systemctl restart psos
sudo systemctl enable --now psos-keepalive.timer
```

## Environment

`/etc/psos.env` is root-owned (0600) and holds secrets — **never** in git:

| Key | Why |
|---|---|
| `PSOS_PASSWORD` | the single-user gate; rotate with `psos-set-password` |
| `PSOS_BEHIND_TLS=1` | Tailscale Funnel terminates TLS in front of us: makes the session cookie `Secure` and makes `x-forwarded-for` trustworthy |

Vertex AI needs no key — the VM's own service account via ADC
(`VERTEX_USE_ADC=1`, `--scopes=cloud-platform`, `roles/aiplatform.user`).

## Tailscale

```bash
tailscale up --hostname=psos --accept-dns=false   # --accept-dns=false is load-bearing
sudo tailscale funnel --bg 3000
```

`--accept-dns=false`: MagicDNS rewrites `/etc/resolv.conf`, and the app resolves
`metadata.google.internal` for Vertex ADC. Letting Tailscale own DNS breaks image
generation.

Both `serve` and `funnel` **block waiting for a browser approval** the first time
(they print a `login.tailscale.com/f/...` link). That is not a hang — bound them
with `timeout` and read the link out of the output.

## Checking it

```bash
systemctl list-timers psos-keepalive.timer
journalctl -t psos-keepalive -n 20          # every decision is logged
cat /run/psos/keepalive                     # UNIX-ms deadline, or absent
cat /run/systemd/shutdown/scheduled         # USEC=… if a poweroff is armed
sudo /usr/local/bin/psos-keepalive-check    # force a decision now
```
