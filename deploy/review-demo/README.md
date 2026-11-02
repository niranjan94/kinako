# App Review demo server

A sandboxed Kinako server that App Review can pair the iOS app with. It runs the free Replay agent, which plays recorded agent turns, so no provider accounts or paid models are involved. The server is reachable only through a Cloudflare Tunnel; no host ports are published.

## Run

```sh
docker compose up -d --build
docker compose logs quick-tunnel | grep -o 'https://.*trycloudflare.com'
```

This uses a Cloudflare quick tunnel, which needs no account. Its URL changes whenever the `quick-tunnel` container restarts, including after a host reboot, and any pairing link you handed out stops working. Keep the host up for the length of the review.

### Stable hostname

For a URL that survives restarts, create a tunnel in Cloudflare Zero Trust under **Networks → Tunnels**, add a public hostname with service `HTTP` and URL `kinako:3873`, and copy its token. Then run:

```sh
TUNNEL_TOKEN=<token> docker compose --profile named up -d --build --scale quick-tunnel=0
```

## Create the reviewer's pairing link

```sh
docker compose exec kinako kinako auth pairing create \
  --base-dir /data \
  --base-url https://<tunnel-hostname> \
  --ttl 30d \
  --label app-review \
  --scope orchestration:read \
  --scope orchestration:operate \
  --scope filesystem:read
```

Each link pairs one device. Create another if it has been used, and revoke old ones with `kinako auth pairing list` and `kinako auth pairing revoke <id>` (both take `--base-dir /data`).

The grant can read and run threads and read project files. It cannot open a terminal, write files, or change settings.

## Replay scenarios

The default model is **Showcase**. The model picker also offers **Plan and reads**, **Write approval**, **Question**, and **Multi turn**. Each message plays the next recorded turn.

## Update

Set `KINAKO_VERSION` to a release in the Dockerfile, then run `docker compose up -d --build`. To start over, run `docker compose down -v`.
