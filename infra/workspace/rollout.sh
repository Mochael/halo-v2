#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT:?}" "${ZONE:?}" "${INSTANCE:?}" "${TEMPLATE:?}" "${WORKSPACE_IMAGE:?}" "${VERSION:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"

template_details=$(gcloud compute instance-templates describe "${TEMPLATE##*/}" \
  --project="$PROJECT" --format=json)
details=$(gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT" --zone="$ZONE" --format=json)
if [ "$(jq -r .status <<< "$details")" != "RUNNING" ]; then
  echo "$INSTANCE must be running before updating its container" >&2
  exit 1
fi
workspace_id=$(jq -er '.metadata.items[] | select(.key == "halo-workspace-id") | .value' <<< "$details")
workspace_label=$(jq -r '.labels["halo-workspace-id"] // empty' <<< "$details")
if [ -n "$workspace_label" ] && [ "$workspace_label" != "$workspace_id" ]; then
  echo "$INSTANCE has workspace label $workspace_label; expected $workspace_id" >&2
  exit 1
fi
owner_user_id=$(jq -r '.metadata.items[] | select(.key == "halo-owner-user-id") | .value' <<< "$details")
if [ -z "$owner_user_id" ]; then
  echo "$INSTANCE has no halo-owner-user-id metadata" >&2
  exit 1
fi
disk=$(jq -r '[.disks[] | select(.boot == false and .deviceName == "halo-workspace") | .source | split("/")[-1]] | if length == 1 then .[0] else empty end' <<< "$details")
if [ "$disk" != "halo-$workspace_id-workspace" ]; then
  echo "$INSTANCE has unexpected workspace disk $disk" >&2
  exit 1
fi

# Image rollouts do not apply hardware, network, or identity changes to existing VMs.
host_config='{
  machineType: (.machineType | split("/")[-1]),
  networks: [.networkInterfaces[] | {network, subnetwork, accessConfigs: (.accessConfigs // [])}],
  serviceAccounts: [.serviceAccounts[] | {email, scopes: (.scopes | sort)}],
  tags: (.tags.items | sort)
}'
expected_host=$(jq -Sc ".properties | $host_config" <<< "$template_details")
actual_host=$(jq -Sc "$host_config" <<< "$details")
if [ "$actual_host" != "$expected_host" ]; then
  echo "$INSTANCE needs a VM configuration update; perform explicit VM maintenance before publishing this release" >&2
  exit 1
fi

startup_script="$RUNNER_TEMP/workspace-startup.sh"
jq -er '.properties.metadata.items[] | select(.key == "startup-script") | .value' \
  <<< "$template_details" > "$startup_script"
metadata=()
while IFS=$'\t' read -r key value; do
  metadata+=("$key=$value")
done < <(jq -r '.properties.metadata.items[] | select(.key != "startup-script" and .key != "halo-owner-user-id" and .key != "halo-workspace-id") | [.key, .value] | @tsv' \
  <<< "$template_details")
metadata_csv=$(IFS=,; echo "${metadata[*]}")

# Persist the desired startup configuration so future reboots use this release.
gcloud compute instances add-metadata "$INSTANCE" \
  --project="$PROJECT" --zone="$ZONE" \
  --metadata="$metadata_csv" --metadata-from-file="startup-script=$startup_script"

# Updating metadata does not run it immediately. Execute the same boot entry point
# over private IAP SSH; its pull completes before it restarts the container.
output="$RUNNER_TEMP/workspace-update.log"
gcloud compute ssh "$INSTANCE" \
  --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet \
  --ssh-key-file="$RUNNER_TEMP/workspace-ssh" --ssh-key-expire-after=30m \
  --command='sudo google_metadata_script_runner startup' 2>&1 | tee "$output"
protocols=$(jq -c .protocols.workspace.supported "releases/$VERSION.json")
ready_marker="HALO_WORKSPACE_READY image=$WORKSPACE_IMAGE protocols=$protocols revision=$GITHUB_SHA"
if ! grep --fixed-strings --quiet "$ready_marker" "$output"; then
  echo "$INSTANCE did not report readiness for $WORKSPACE_IMAGE" >&2
  exit 1
fi
