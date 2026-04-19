linux:
	./scripts/build-linux.sh

linux-arm:
	PLATFORM=linux/arm64 ./scripts/build-linux.sh

rhel-arm:
	./scripts/build-linux-rhel8.sh

rhel-x64:
	PLATFORM=linux/amd64 ./scripts/build-linux-rhel8.sh

mac:
	npm run build:mac