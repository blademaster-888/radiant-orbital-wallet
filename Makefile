.PHONY: dev build

dev:
	npm start

build:
	npm run worker:build
	npm run build
