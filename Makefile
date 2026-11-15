# Jester: one entry point for the four packages (app, engine, clip, eval).
# Needs Node 22.18 or newer (the tests run .ts files directly) and npm. Run `make setup` once, then `make test`.

INSTALL := engine clip eval app
CHECKED := engine clip eval

.DEFAULT_GOAL := help
.PHONY: help setup dev test build

help: ## List the targets
	@echo "Jester (Node 22.18 or newer)"
	@grep -E '^[a-z]+:.*## ' Makefile | awk -F':.*## ' '{ printf "  make %-6s %s\n", $$1, $$2 }'

setup: ## Install every package from its lockfile (npm ci)
	@for p in $(INSTALL); do echo "== $$p: npm ci"; (cd $$p && npm ci --no-audit --no-fund) || exit 1; done

dev: ## Run the game at http://localhost:5173
	cd app && npm run dev

test: ## Typecheck and test engine, clip, eval, app and the webcam side
	@for p in $(CHECKED); do echo "== $$p: typecheck and tests"; (cd $$p && npm run check) || exit 1; done
	@echo "== webcam side and rooms (spikes/pose-match): tests"
	node --test spikes/pose-match/
	@echo "== app: typecheck and tests"
	cd app && npm run typecheck && npm test

build: ## Typecheck and build the game into app/dist
	cd app && npm run build
