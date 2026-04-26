module.exports = {
  FILE_WATCH_DEBOUNCE_MS: 150, // fs.watch → file:changed-on-disk
  PROJECT_WATCH_DEBOUNCE_MS: 300, // recursive project dir watcher → dir:changed
  SITE_PKG_POLL_MS: 250, // site-packages mtime poll interval
}
