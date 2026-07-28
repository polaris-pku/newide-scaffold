#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${NEWIDE_B_POSTGRES_CONTAINER:-newide-b-memory-postgres}"
IMAGE="${NEWIDE_B_POSTGRES_IMAGE:-pgvector/pgvector:0.8.2-pg17-bookworm}"
VOLUME_NAME="${NEWIDE_B_POSTGRES_VOLUME:-newide_b_memory_pgdata}"
HOST="${NEWIDE_B_POSTGRES_HOST:-127.0.0.1}"
PORT="${NEWIDE_B_POSTGRES_PORT:-55432}"
DATABASE="${NEWIDE_B_POSTGRES_DATABASE:-newide_b}"
USER_NAME="${NEWIDE_B_POSTGRES_USER:-newide}"
PASSWORD="${NEWIDE_B_POSTGRES_PASSWORD:-newide_local}"
STARTUP_TIMEOUT_SECONDS="${NEWIDE_B_POSTGRES_STARTUP_TIMEOUT_SECONDS:-180}"

log() {
  printf '[newIDE postgres] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  fail 'docker was not found; install Docker Desktop or set NEWIDE_B_DATABASE_URL explicitly.'
fi

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname -s)" == 'Darwin' ]] && command -v open >/dev/null 2>&1; then
    log 'Docker daemon is unavailable; starting Docker Desktop.'
    open -ga Docker
  else
    fail 'Docker daemon is unavailable; start Docker and retry.'
  fi

  deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  until docker info >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      fail "Docker did not become ready within ${STARTUP_TIMEOUT_SECONDS}s."
    fi
    sleep 2
  done
fi

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  log "Creating ${CONTAINER_NAME} from ${IMAGE}."
  if ! docker run --detach \
    --name "$CONTAINER_NAME" \
    --env "POSTGRES_DB=$DATABASE" \
    --env "POSTGRES_USER=$USER_NAME" \
    --env "POSTGRES_PASSWORD=$PASSWORD" \
    --publish "${HOST}:${PORT}:5432" \
    --volume "${VOLUME_NAME}:/var/lib/postgresql/data" \
    --health-cmd "pg_isready -U ${USER_NAME} -d ${DATABASE}" \
    --health-interval 2s \
    --health-timeout 5s \
    --health-retries 30 \
    "$IMAGE" >/dev/null; then
    if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
      fail "Failed to create ${CONTAINER_NAME}."
    fi
    log "Container ${CONTAINER_NAME} was created by another startup process."
  fi
elif [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" != 'true' ]]; then
  log "Starting existing container ${CONTAINER_NAME}."
  docker start "$CONTAINER_NAME" >/dev/null
fi

deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
until docker exec "$CONTAINER_NAME" pg_isready -U "$USER_NAME" -d "$DATABASE" >/dev/null 2>&1; do
  if [[ "$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)" == 'exited' ]]; then
    docker logs --tail 40 "$CONTAINER_NAME" >&2 || true
    fail "${CONTAINER_NAME} exited before PostgreSQL became ready."
  fi
  if (( SECONDS >= deadline )); then
    docker logs --tail 40 "$CONTAINER_NAME" >&2 || true
    fail "PostgreSQL did not become ready within ${STARTUP_TIMEOUT_SECONDS}s."
  fi
  sleep 2
done

log "ready at ${HOST}:${PORT}/${DATABASE} (container=${CONTAINER_NAME}, volume=${VOLUME_NAME})"
printf 'postgresql://%s:%s@%s:%s/%s\n' "$USER_NAME" "$PASSWORD" "$HOST" "$PORT" "$DATABASE"
