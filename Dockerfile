# fpvsim — the page, its COOP/COEP headers, and the usage collector.
#
# The box is a bare Windows desktop that lost both servers to a reboot, which is
# the failure this image exists to end: `--restart unless-stopped` brings it
# back by itself, the way the other services on that machine already do.
#
# **alpine, not python:3.12-slim, and that is not a size preference.** Docker
# Desktop's credential helper needs an interactive logon session, so any build
# that pulls a base image from a registry dies over SSH with "A specified logon
# session does not exist" — which is why the sibling service has to build
# through Task Scheduler. alpine:3.20 is already on the box and apk needs no
# credential helper, so this image builds over a plain SSH connection with no
# scheduled task in the middle. If the base is ever pruned, the first build
# after that has to be run from the desktop.
FROM alpine:3.20

# Python, not Node: the box has no Node and needs none. Every byte of flight
# computation happens in the visitor's browser; this hands over static files and
# keeps a log of who flew.
RUN apk add --no-cache python3

WORKDIR /app

# Two stdlib scripts. There is no requirements.txt and deliberately no
# framework — the server does nothing per visitor beyond handing over 80 KB.
COPY serve.py admin.py ./
COPY dist ./dist

# Everything stateful is mounted, never baked. A rebuild must not be able to
# take the collected sessions with it — that is the whole point of the exercise,
# and `.dockerignore` keeps data/ out of the build context so it cannot become a
# layer by accident either.
VOLUME ["/data"]

# COOP/COEP are sent by serve.py itself rather than by anything in front of it,
# so they survive whatever ends up serving this. Lose them and the 1 kHz ticker
# falls back to a timer, quietly, and the page still works well enough that
# nobody reports it.
EXPOSE 5180

# busybox wget, already in the base. The check is that the page is actually
# answering, not that the process exists — a python process that has stopped
# serving looks identical to a healthy one from the outside.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5180/ || exit 1

# 0.0.0.0 inside the container, because a container's interfaces are private to
# it; what the world can reach is decided by the host's `-p` publishing. That
# distinction matters most for admin.py, whose documented access control *is*
# its bind address — in a container that control moves to `docker run -p`, and
# reading the old comment as though it still applied would be a mistake.
#
# --reference points at a mount that is normally empty: the reference laps are
# videos, they live beside dist rather than in it, and baking them into the
# image would put hundreds of megabytes in a layer for a feature that is parked.
CMD ["python3", "/app/serve.py", \
     "--port", "5180", "--host", "0.0.0.0", \
     "--root", "/app/dist", "--data", "/data", \
     "--reference", "/app/reference"]
