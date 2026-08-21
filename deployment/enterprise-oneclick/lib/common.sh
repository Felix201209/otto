#!/usr/bin/env bash

# Otto Enterprise 一键部署公共函数。调用方必须先 set -Eeuo pipefail。

OTTO_NODE_VERSION="22.23.1"
OTTO_NODE_MIN_VERSION="22.16.0"
OTTO_NODE_X64_SHA256="7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129"
OTTO_NODE_ARM64_SHA256="543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d"

otto_log() {
  printf '[Otto Deploy] %s\n' "$*"
}

otto_warn() {
  printf '[Otto Deploy] 警告：%s\n' "$*" >&2
}

otto_die() {
  local message="$1"
  local status="${2:-2}"
  printf '[Otto Deploy] 错误：%s\n' "$message" >&2
  exit "$status"
}

otto_require_command() {
  command -v "$1" >/dev/null 2>&1 || otto_die "缺少命令：$1"
}

otto_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

otto_verify_package_manifest() {
  local package_root="$1"
  local manifest="${package_root}/PACKAGE-MANIFEST.sha256"
  [ -f "$manifest" ] && [ ! -L "$manifest" ] \
    || otto_die "部署包缺少普通文件 PACKAGE-MANIFEST.sha256" 3

  local line expected relative absolute actual count=0
  while IFS= read -r line || [ -n "$line" ]; do
    expected="${line%%  *}"
    relative="${line#*  }"
    [ "$relative" != "$line" ] \
      && [ "${#expected}" -eq 64 ] \
      && [[ "$expected" =~ ^[a-f0-9]+$ ]] \
      || otto_die "部署包清单格式无效" 3
    case "$relative" in
      ""|/*|.|..|../*|*/../*|*/..|./*|*/./*|*/.)
        otto_die "部署包清单包含不安全路径：${relative}" 3
        ;;
    esac
    absolute="${package_root}/${relative}"
    [ -f "$absolute" ] && [ ! -L "$absolute" ] \
      || otto_die "部署包清单目标缺失、不是普通文件或是符号链接：${relative}" 3
    actual="$(otto_sha256 "$absolute")"
    [ "$actual" = "$expected" ] \
      || otto_die "部署包文件 SHA-256 不匹配：${relative}" 3
    count=$((count + 1))
  done < "$manifest"
  [ "$count" -ge 10 ] || otto_die "部署包清单条目异常：${count}" 3
  otto_log "部署包清单校验通过：${count} 个文件"
}

otto_version_at_least() {
  local actual="${1#v}"
  local minimum="${2#v}"
  [ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n 1)" = "$minimum" ]
}

otto_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) otto_die "仅支持 Linux x86_64/amd64 与 aarch64/arm64，当前为 $(uname -m)" 3 ;;
  esac
}

otto_node_sha256() {
  case "$1" in
    x64) printf '%s\n' "$OTTO_NODE_X64_SHA256" ;;
    arm64) printf '%s\n' "$OTTO_NODE_ARM64_SHA256" ;;
    *) otto_die "未知 Node 架构：$1" ;;
  esac
}

otto_resolve_node() {
  local preferred="${1:-}"
  if [ -n "$preferred" ] && [ -x "$preferred" ]; then
    local preferred_version
    preferred_version="$("$preferred" --version)"
    if otto_version_at_least "$preferred_version" "$OTTO_NODE_MIN_VERSION"; then
      printf '%s\n' "$preferred"
      return
    fi
  fi
  if command -v node >/dev/null 2>&1; then
    local system_node
    local system_version
    system_node="$(command -v node)"
    system_version="$("$system_node" --version)"
    if otto_version_at_least "$system_version" "$OTTO_NODE_MIN_VERSION"; then
      printf '%s\n' "$system_node"
      return
    fi
  fi
  return 1
}

otto_install_node_runtime() {
  local runtime_parent="$1"
  local arch
  arch="$(otto_arch)"
  local runtime_dir="${runtime_parent}/node-v${OTTO_NODE_VERSION}-linux-${arch}"
  local node_path="${runtime_dir}/bin/node"

  if [ -x "$node_path" ]; then
    local found_version
    found_version="$("$node_path" --version)"
    [ "$found_version" = "v${OTTO_NODE_VERSION}" ] \
      || otto_die "已有 Node runtime 版本异常：${found_version}"
    printf '%s\n' "$node_path"
    return
  fi

  otto_require_command curl
  otto_require_command tar
  local archive="node-v${OTTO_NODE_VERSION}-linux-${arch}.tar.gz"
  local url="https://nodejs.org/dist/v${OTTO_NODE_VERSION}/${archive}"
  local expected
  expected="$(otto_node_sha256 "$arch")"
  local temp_dir
  temp_dir="$(mktemp -d)"
  local temp_archive="${temp_dir}/${archive}"

  otto_log "下载固定 Node.js v${OTTO_NODE_VERSION} (${arch})" >&2
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 \
    --output "$temp_archive" "$url"
  local actual
  actual="$(otto_sha256 "$temp_archive")"
  [ "$actual" = "$expected" ] \
    || otto_die "Node runtime SHA-256 不匹配：期望 ${expected}，实际 ${actual}" 3

  mkdir -p "$runtime_parent"
  tar -xzf "$temp_archive" -C "$runtime_parent"
  [ -x "$node_path" ] || otto_die "Node runtime 解压后入口不存在" 3
  [ "$("$node_path" --version)" = "v${OTTO_NODE_VERSION}" ] \
    || otto_die "Node runtime 自检失败" 3
  rm -rf "$temp_dir"
  printf '%s\n' "$node_path"
}

otto_prepare_service_layout() {
  local install_root="$1"
  local target_release="$2"
  local runtime_root="${install_root}/runtime"
  local releases_root="${install_root}/releases"

  case "$target_release" in
    "${releases_root}/"*) ;;
    *) otto_die "目标 release 不在受控 releases 目录：${target_release}" 3 ;;
  esac
  for directory in \
    "$install_root" \
    "$runtime_root" \
    "$releases_root" \
    "$target_release"; do
    [ -d "$directory" ] && [ ! -L "$directory" ] \
      || otto_die "systemd 服务路径不是普通目录：${directory}" 3
  done

  # install.sh 全程使用 umask 077；若不显式收紧为可遍历布局，root canary
  # 会通过，但 User=otto-enterprise 的 systemd 服务无法进入 /opt 下的目录。
  chmod 0755 "$install_root" "$runtime_root" "$releases_root"
  chmod -R a+rX,go-w "$runtime_root" "$target_release"
}

otto_load_config() {
  local config_path="$1"
  [ -f "$config_path" ] || otto_die "配置文件不存在：${config_path}"
  [ ! -L "$config_path" ] || otto_die "配置文件不能是符号链接：${config_path}"

  local raw line key value
  while IFS= read -r raw || [ -n "$raw" ]; do
    line="${raw%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == *=* ]] || otto_die "配置行必须是 KEY=VALUE：${raw}"
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    case "$key" in
      OTTO_PUBLIC_HOST|OTTO_PUBLIC_PORT|OTTO_ENTERPRISE_PUBLIC_URL|\
      OTTO_ENTERPRISE_DIR|OTTO_ENTERPRISE_HOST|OTTO_ENTERPRISE_PORT|\
      OTTO_ENTERPRISE_TRUST_PROXY_HOPS|OTTO_APP_VERSION|OTTO_BUILD_COMMIT|\
      OTTO_ENTERPRISE_ADMIN_TOKEN|OTTO_BOOTSTRAP_USERNAME|\
      OTTO_BOOTSTRAP_PASSWORD|OTTO_BOOTSTRAP_NAME|OTTO_CADDY_MODE|\
      OTTO_ALLOW_SMS_DISABLED|ALIYUN_SMS_PROVIDER|\
      ALIYUN_SMS_ACCESS_KEY_ID|ALIYUN_SMS_ACCESS_KEY_SECRET|\
      ALIYUN_SMS_SIGN_NAME|ALIYUN_SMS_TEMPLATE_ID|\
      ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID|\
      OTTO_ENTERPRISE_FEISHU_APP_ID|OTTO_ENTERPRISE_FEISHU_APP_SECRET|\
      OTTO_ENTERPRISE_FEISHU_DOMAIN|\
      OTTO_DEFAULT_ORGANIZATION_NAME|OTTO_ENTERPRISE_USAGE_DAILY_LIMIT|\
      OTTO_CREDIT_TOKEN_RATE|OTTO_ESTIMATE_MANUAL_MULT|\
      OTTO_ESTIMATE_CNY_PER_HOUR|OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP|\
      OTTO_BACKUP_ENCRYPTION_KEY|OTTO_BACKUP_INTERVAL_HOURS|\
      OTTO_BACKUP_RETENTION_DAYS|OTTO_BACKUP_MINIMUM_RETAINED|\
      OTTO_BACKUP_REPLICA_DIR|OTTO_DISK_MIN_FREE_MB|\
      OTTO_ACCOUNT_SYNC_ENCRYPTION_KEY_FILE|\
      OTTO_ATTACHMENT_ENCRYPTION_KEY_FILE|OTTO_FIELD_ENCRYPTION_KEY_FILE|\
      OTTO_CONTROL_URL|OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE|\
      OTTO_DEPLOYMENT_KIND|\
      OTTO_TELEMETRY_ENDPOINT|OTTO_TELEMETRY_RETENTION_DAYS|\
      OTTO_FEDERATION_ENABLED|OTTO_FEDERATION_GATEWAY_URL|\
      OTTO_FEDERATION_DISPLAY_NAME|OTTO_FEDERATION_POLL_INTERVAL_MS|\
      OTTO_FEDERATION_SIGNING_KEY_FILE|\
      OTTO_DATA_CONTROLLER_NAME|OTTO_PRIVACY_CONTACT|OTTO_LEGAL_DOCUMENTS_APPROVED|\
      OTTO_DATA_REGION|\
      OTTO_DATA_RESIDENCY|OTTO_STORAGE_VOLUME_ENCRYPTED|\
      OTTO_CROSS_BORDER_DATA_ENABLED)
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
          value="${value:1:${#value}-2}"
        fi
        printf -v "$key" '%s' "$value"
        export "$key"
        ;;
      *)
        otto_die "配置包含不允许的键：${key}"
        ;;
    esac
  done < "$config_path"
}

otto_random_secret() {
  local node_path="$1"
  "$node_path" --input-type=module -e \
    "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
}
