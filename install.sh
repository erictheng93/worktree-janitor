#!/bin/sh
# worktree-janitor installer for macOS and Linux. POSIX sh, no sudo.
#
#   curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/erictheng93/worktree-janitor/releases/latest/download/install.sh | sh -s -- --version v0.1.0 --codex
#
# Run `sh install.sh --help` for the options. What it does:
#   1. downloads worktree-janitor-<version>.tar.gz and SHA256SUMS from the
#      GitHub release and verifies the hash (any doubt aborts the install),
#   2. unpacks it to <dir>/<version> and points the symlink <dir>/current at it,
#   3. writes the launcher <bin-dir>/worktree-janitor, which runs the node
#      found at install time (absolute path),
#   4. runs `node <dir>/current/scripts/install.mjs --claude/--codex` for the
#      CLIs selected (default: the ones found on PATH).
# Running it again is safe: the same version is not downloaded twice and the
# integrations are only changed when something differs.
#
# Environment (optional):
#   WORKTREE_JANITOR_BASE_URL  where the release assets are (default: the GitHub
#                              release of --version); an https:// URL, a
#                              file:// URL or a local directory (mirrors, tests)
#   WORKTREE_JANITOR_API_URL   latest-release endpoint (default: GitHub API)
#   HTTPS_PROXY / https_proxy  used by curl and wget
#
# Everything is inside functions; the only command at top level is the call
# on the last line, so a truncated download runs nothing.

wj_usage() {
  cat <<'EOF'
worktree-janitor installer (macOS, Linux)

  sh install.sh [--version vX.Y.Z] [--dir DIR] [--bin-dir DIR] [--node PATH]
                [--claude] [--codex] [--all] [--none] [--uninstall] [--dry-run]

  --version vX.Y.Z  release to install (default: the latest release)
  --dir DIR         install root (default: ~/.worktree-janitor)
  --bin-dir DIR     where the worktree-janitor launcher goes (default: ~/.local/bin)
  --node PATH       node executable to use (default: node on PATH; Node.js 18+)
  --claude          also set up the Claude Code plugin (needs `claude` on PATH)
  --codex           also set up Codex hooks, skill and AGENTS.md rule
  --all             both
  --none            neither (files and launcher only)
                    default: every CLI of the two that is on PATH
  --uninstall       remove the integrations (all of them unless --claude,
                    --codex or --none is given), the launcher and DIR
  --dry-run         print what would happen, change nothing
EOF
}

wj_say() { printf '%s\n' "$*"; }
wj_err() { printf 'install.sh: error: %s\n' "$*" >&2; }

# wj_fetch URL DEST: https via curl or wget; file:// URLs and absolute paths
# are copied (mirrors and tests).
wj_fetch() {
  case $1 in
    file://*) cp "${1#file://}" "$2" 2>/dev/null ;;
    /*) cp "$1" "$2" 2>/dev/null ;;
    https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1"
      else
        wj_err "neither curl nor wget is installed"
        return 1
      fi
      ;;
    *)
      wj_err "refusing to download over a non-https URL"
      return 1
      ;;
  esac
}

wj_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else
    return 1
  fi
}

# Is this file ours? Only files carrying the marker are replaced or removed.
wj_ours() { [ -f "$1" ] && grep -q 'installed by worktree-janitor install.sh' "$1" 2>/dev/null; }

# Single-quote a string for sh.
wj_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

wj_main() {
  wj_repo=erictheng93/worktree-janitor
  wj_version=''
  wj_dir=''
  wj_bin=''
  wj_node=''
  wj_claude=0
  wj_codex=0
  wj_none=0
  wj_pick=0
  wj_uninstall=0
  wj_dry=0
  while [ $# -gt 0 ]; do
    case $1 in
      --version | --dir | --bin-dir | --node)
        if [ $# -lt 2 ]; then
          wj_err "$1 needs a value"
          return 2
        fi
        case $1 in
          --version) wj_version=$2 ;;
          --dir) wj_dir=$2 ;;
          --bin-dir) wj_bin=$2 ;;
          --node) wj_node=$2 ;;
        esac
        shift 2
        continue
        ;;
      --version=*) wj_version=${1#*=} ;;
      --dir=*) wj_dir=${1#*=} ;;
      --bin-dir=*) wj_bin=${1#*=} ;;
      --node=*) wj_node=${1#*=} ;;
      --claude) wj_claude=1 wj_pick=1 ;;
      --codex) wj_codex=1 wj_pick=1 ;;
      --all) wj_claude=1 wj_codex=1 wj_pick=1 ;;
      --none) wj_none=1 wj_pick=1 ;;
      --uninstall) wj_uninstall=1 ;;
      --dry-run) wj_dry=1 ;;
      -h | --help)
        wj_usage
        return 0
        ;;
      *)
        wj_err "unknown argument: $1 (see --help)"
        return 2
        ;;
    esac
    shift
  done
  if [ "$wj_none" = 1 ] && { [ "$wj_claude" = 1 ] || [ "$wj_codex" = 1 ]; }; then
    wj_err "--none cannot be combined with --claude, --codex or --all"
    return 2
  fi
  if [ -z "${HOME:-}" ]; then
    wj_err "HOME is not set"
    return 1
  fi
  [ -n "$wj_dir" ] || wj_dir=$HOME/.worktree-janitor
  [ -n "$wj_bin" ] || wj_bin=$HOME/.local/bin
  case $wj_dir in /*) ;; *) wj_dir=$(pwd)/$wj_dir ;; esac
  case $wj_bin in /*) ;; *) wj_bin=$(pwd)/$wj_bin ;; esac
  wj_dir=${wj_dir%/}
  wj_bin=${wj_bin%/}
  wj_launcher=$wj_bin/worktree-janitor
  wj_pre=''
  [ "$wj_dry" = 1 ] && wj_pre='would '

  # wget reads only the lower-case variable.
  if [ -n "${HTTPS_PROXY:-}" ] && [ -z "${https_proxy:-}" ]; then
    https_proxy=$HTTPS_PROXY
    export https_proxy
  fi

  if [ "$wj_uninstall" = 1 ]; then
    wj_uninstall_all
    return $?
  fi
  wj_install
}

# Which integrations: the explicit choice, else every CLI found on PATH.
wj_pick_integrations() {
  if [ "$wj_pick" = 0 ]; then
    command -v claude >/dev/null 2>&1 && wj_claude=1
    command -v codex >/dev/null 2>&1 && wj_codex=1
  fi
  return 0
}

wj_find_node() {
  if [ -z "$wj_node" ]; then
    wj_node=$(command -v node 2>/dev/null) || wj_node=''
  fi
  if [ -z "$wj_node" ]; then
    wj_err "node (Node.js 18 or newer) is not on PATH; install it first (macOS: brew install node; Debian/Ubuntu: sudo apt-get install nodejs; Fedora/RHEL: sudo dnf install nodejs) or pass --node PATH"
    return 1
  fi
  case $wj_node in
    /*) ;;
    *)
      wj_err "--node must be an absolute path"
      return 1
      ;;
  esac
  if ! "$wj_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    wj_err "$wj_node is not Node.js 18 or newer"
    return 1
  fi
  return 0
}

wj_install() {
  wj_find_node || return 1
  command -v git >/dev/null 2>&1 || wj_say "warning: git is not on PATH; worktree-janitor needs git 2.7 or newer at run time"
  wj_pick_integrations

  wj_tmp=$(mktemp -d 2>/dev/null || mktemp -d -t worktree-janitor) || {
    wj_err "cannot create a temporary directory"
    return 1
  }
  trap 'rm -rf "$wj_tmp"' EXIT
  trap 'rm -rf "$wj_tmp"; exit 130' INT TERM
  wj_install_in_tmp
  wj_rc=$?
  rm -rf "$wj_tmp"
  trap - EXIT INT TERM
  return $wj_rc
}

wj_install_in_tmp() {
  if [ -z "$wj_version" ]; then
    wj_api=${WORKTREE_JANITOR_API_URL:-https://api.github.com/repos/$wj_repo/releases/latest}
    if ! wj_fetch "$wj_api" "$wj_tmp/latest.json"; then
      wj_err "could not look up the latest release of $wj_repo (none published yet, or no network). Pass --version vX.Y.Z"
      return 1
    fi
    wj_version=$(sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$wj_tmp/latest.json" | head -n 1)
    if [ -z "$wj_version" ]; then
      wj_err "the latest-release response has no tag_name; pass --version vX.Y.Z"
      return 1
    fi
  fi
  case $wj_version in v*) ;; *) wj_version=v$wj_version ;; esac
  case $wj_version in
    *[!0-9A-Za-z.-]* | v | v.*)
      wj_err "bad version: $wj_version"
      return 2
      ;;
  esac
  wj_asset=worktree-janitor-$wj_version.tar.gz
  wj_base=${WORKTREE_JANITOR_BASE_URL:-https://github.com/$wj_repo/releases/download/$wj_version}
  wj_base=${wj_base%/}
  wj_target=$wj_dir/$wj_version
  wj_say "worktree-janitor $wj_version -> $wj_target"

  if ! wj_fetch "$wj_base/SHA256SUMS" "$wj_tmp/SHA256SUMS"; then
    wj_err "could not download SHA256SUMS for $wj_version (does the release exist?)"
    return 1
  fi
  wj_want=$(awk -v f="$wj_asset" '$2 == f || $2 == "*" f { print $1; exit }' "$wj_tmp/SHA256SUMS")
  case $wj_want in
    [0-9a-f]*) ;;
    *)
      wj_err "SHA256SUMS has no entry for $wj_asset"
      return 1
      ;;
  esac
  if [ "${#wj_want}" -ne 64 ]; then
    wj_err "SHA256SUMS entry for $wj_asset is malformed"
    return 1
  fi

  # Same version, same archive hash, files present: nothing to download.
  wj_stamp=$wj_target/.worktree-janitor-sha256
  if [ -f "$wj_stamp" ] && [ "$(cat "$wj_stamp")" = "$wj_want" ] && [ -f "$wj_target/scripts/janitor.mjs" ]; then
    wj_say "  ok $wj_target (already unpacked, sha256 $wj_want)"
    wj_src=$wj_target
  else
    if ! wj_fetch "$wj_base/$wj_asset" "$wj_tmp/$wj_asset"; then
      wj_err "could not download $wj_asset"
      return 1
    fi
    if ! wj_got=$(wj_sha256 "$wj_tmp/$wj_asset") || [ -z "$wj_got" ]; then
      wj_err "no sha256 tool (sha256sum, shasum or openssl) found; refusing to install unverified files"
      return 1
    fi
    if [ "$wj_got" != "$wj_want" ]; then
      wj_err "sha256 mismatch for $wj_asset: expected $wj_want, got $wj_got. Nothing was installed."
      return 1
    fi
    wj_say "  verified $wj_asset (sha256 $wj_want)"
    mkdir "$wj_tmp/x" && tar -xzf "$wj_tmp/$wj_asset" -C "$wj_tmp/x" || {
      wj_err "could not unpack $wj_asset"
      return 1
    }
    wj_src=$wj_tmp/x/worktree-janitor-$wj_version
    if [ ! -f "$wj_src/scripts/janitor.mjs" ] || [ ! -f "$wj_src/scripts/install.mjs" ]; then
      wj_err "$wj_asset does not contain worktree-janitor-$wj_version/scripts/janitor.mjs"
      return 1
    fi
    printf '%s\n' "$wj_want" >"$wj_src/.worktree-janitor-sha256"
    printf 'installed by worktree-janitor install.sh\n' >"$wj_src/.worktree-janitor-install"
    if [ "$wj_dry" = 1 ]; then
      wj_say "  would unpack to $wj_target"
    else
      mkdir -p "$wj_dir" || return 1
      # Stage next to the target (same file system), then swap in.
      wj_stage=$wj_dir/.staging.$$
      rm -rf "$wj_stage"
      cp -R "$wj_src" "$wj_stage" || {
        rm -rf "$wj_stage"
        wj_err "could not write to $wj_dir"
        return 1
      }
      rm -rf "$wj_target"
      mv "$wj_stage" "$wj_target" || return 1
      wj_say "  unpacked to $wj_target"
      wj_src=$wj_target
    fi
  fi

  wj_current=$wj_dir/current
  if [ -e "$wj_current" ] && [ ! -L "$wj_current" ]; then
    wj_err "$wj_current exists and is not a symlink; not touching it"
    return 1
  fi
  if [ -L "$wj_current" ] && [ "$(readlink "$wj_current")" = "$wj_version" ]; then
    wj_say "  ok $wj_current -> $wj_version"
  elif [ "$wj_dry" = 1 ]; then
    wj_say "  would link $wj_current -> $wj_version"
  else
    ln -sfn "$wj_version" "$wj_current" || return 1
    wj_say "  linked $wj_current -> $wj_version"
  fi

  # Other versions are no longer referenced by anything; remove them.
  for wj_old in "$wj_dir"/v*; do
    [ -d "$wj_old" ] || continue
    [ "$wj_old" = "$wj_target" ] && continue
    [ -f "$wj_old/.worktree-janitor-install" ] || continue
    wj_say "  ${wj_pre}remove old version $wj_old"
    [ "$wj_dry" = 1 ] || rm -rf "$wj_old"
  done

  wj_write_launcher || return 1

  wj_rc=0
  for wj_kind in claude codex; do
    eval "wj_on=\$wj_$wj_kind"
    [ "$wj_on" = 1 ] || continue
    if [ "$wj_dry" = 1 ]; then
      "$wj_node" "$wj_src/scripts/install.mjs" "--$wj_kind" --root "$wj_current" --node "$wj_node" --dry-run || wj_rc=1
    else
      "$wj_node" "$wj_current/scripts/install.mjs" "--$wj_kind" --root "$wj_current" --node "$wj_node" || wj_rc=1
    fi
  done
  if [ "$wj_claude" = 0 ] && [ "$wj_codex" = 0 ]; then
    wj_say "  no Claude Code / Codex integration (none selected or found on PATH)"
  fi

  case :${PATH:-}: in
    *:"$wj_bin":*) ;;
    *) wj_say "note: $wj_bin is not on PATH. Add it, e.g.: echo 'export PATH=\"$wj_bin:\$PATH\"' >> ~/.profile" ;;
  esac
  if [ "$wj_dry" = 1 ]; then
    wj_say "Dry run: nothing was changed."
  elif [ "$wj_rc" = 0 ]; then
    wj_say "Done. Try: worktree-janitor --help"
  fi
  return $wj_rc
}

wj_write_launcher() {
  if [ -e "$wj_launcher" ] && ! wj_ours "$wj_launcher"; then
    wj_err "$wj_launcher exists and was not installed by worktree-janitor; not overwriting it"
    return 1
  fi
  wj_script=$wj_dir/current/scripts/janitor.mjs
  wj_text="#!/bin/sh
# worktree-janitor launcher, installed by worktree-janitor install.sh.
# Remove with: sh install.sh --uninstall
for n in $(wj_q "$wj_node") \"\$(command -v node 2>/dev/null)\"; do
  if [ -n \"\$n\" ] && [ -x \"\$n\" ]; then exec \"\$n\" $(wj_q "$wj_script") \"\$@\"; fi
done
echo 'worktree-janitor: node not found (looked for $(printf '%s' "$wj_node" | sed "s/'//g") and node on PATH)' >&2
exit 127
"
  if [ -f "$wj_launcher" ] && [ "$(cat "$wj_launcher")
" = "$wj_text" ]; then
    wj_say "  ok $wj_launcher"
    return 0
  fi
  if [ "$wj_dry" = 1 ]; then
    wj_say "  would write $wj_launcher"
    return 0
  fi
  mkdir -p "$wj_bin" || return 1
  printf '%s' "$wj_text" >"$wj_launcher.tmp.$$" && chmod 755 "$wj_launcher.tmp.$$" && mv -f "$wj_launcher.tmp.$$" "$wj_launcher" || {
    rm -f "$wj_launcher.tmp.$$"
    wj_err "could not write $wj_launcher"
    return 1
  }
  wj_say "  wrote $wj_launcher"
}

wj_uninstall_all() {
  wj_rc=0
  if [ "$wj_pick" = 0 ]; then
    wj_claude=1
    wj_codex=1
  fi
  wj_current=$wj_dir/current
  if [ "$wj_claude" = 1 ] || [ "$wj_codex" = 1 ]; then
    if [ -f "$wj_current/scripts/install.mjs" ] && { [ -n "$wj_node" ] || wj_node=$(command -v node 2>/dev/null); }; then
      for wj_kind in claude codex; do
        eval "wj_on=\$wj_$wj_kind"
        [ "$wj_on" = 1 ] || continue
        if [ "$wj_dry" = 1 ]; then
          "$wj_node" "$wj_current/scripts/install.mjs" "--$wj_kind" --uninstall --root "$wj_current" --dry-run || wj_rc=1
        else
          "$wj_node" "$wj_current/scripts/install.mjs" "--$wj_kind" --uninstall --root "$wj_current" || wj_rc=1
        fi
      done
    else
      wj_say "  skipped Claude Code / Codex cleanup: no $wj_current/scripts/install.mjs or no node"
    fi
  fi
  if [ "$wj_rc" != 0 ]; then
    wj_err "integration cleanup failed; the files under $wj_dir are kept so you can retry"
    return 1
  fi
  if wj_ours "$wj_launcher"; then
    wj_say "  ${wj_pre}delete $wj_launcher"
    [ "$wj_dry" = 1 ] || rm -f "$wj_launcher"
  elif [ -e "$wj_launcher" ]; then
    wj_say "  kept $wj_launcher (not installed by worktree-janitor)"
  fi
  if [ -L "$wj_current" ]; then
    wj_say "  ${wj_pre}delete $wj_current"
    [ "$wj_dry" = 1 ] || rm -f "$wj_current"
  fi
  for wj_old in "$wj_dir"/v* "$wj_dir"/.staging.*; do
    [ -d "$wj_old" ] || continue
    [ -L "$wj_old" ] && continue
    [ -f "$wj_old/.worktree-janitor-install" ] || [ -f "$wj_old/.worktree-janitor-sha256" ] || continue
    wj_say "  ${wj_pre}delete $wj_old"
    [ "$wj_dry" = 1 ] || rm -rf "$wj_old"
  done
  if [ -d "$wj_dir" ] && [ "$wj_dry" = 0 ]; then
    rmdir "$wj_dir" 2>/dev/null && wj_say "  deleted $wj_dir" || wj_say "  kept $wj_dir (it holds files worktree-janitor did not install)"
  fi
  if [ "$wj_dry" = 1 ]; then wj_say "Dry run: nothing was changed."; else wj_say "Uninstalled."; fi
  return 0
}

wj_main "$@"
