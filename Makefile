IMAGE   := scribe:dev
PORT    := 3000

.PHONY: build run stop logs shell clean dev dev-down dev-clean dev-options

build:
	docker build -t $(IMAGE) .

# Writes dev-data/options.json (with a dev setup code) if it is absent.
dev-options:
	node scripts/dev-options.mjs

run: build dev-options
	mkdir -p dev-media
	docker run -d --name scribe \
		-p $(PORT):3000 \
		-e LOG_LEVEL=debug \
		-v "$(CURDIR)/dev-data":/data \
		-v "$(CURDIR)/dev-media":/media \
		$(IMAGE)
	@echo "Running at http://localhost:$(PORT)"

stop:
	docker stop scribe && docker rm scribe

logs:
	docker logs -f scribe

shell:
	docker exec -it scribe sh

clean:
	docker rmi $(IMAGE) 2>/dev/null || true

dev-clean:
	docker compose -f docker-compose.dev.yml down --rmi all -v 2>/dev/null || true

# Dev: live-reload via docker compose, auto-selecting a free host port per
# worktree (server 3000-3099, client 5173-5272) with a per-worktree project name.
dev: dev-options
	mkdir -p dev-media
	node scripts/dev-compose.mjs up --build

dev-down:
	node scripts/dev-compose.mjs down
