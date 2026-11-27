#!/bin/bash -p
# server/agents/headless/holder.sh — the holder of one headless worker, with its relay.
#   /bin/bash -p holder.sh <dir> <command> [args…]
# host.ts starts it in the worker's systemd user scope, in a new session (setsid), with a fixed
# environment, so a restart of the console does not end it. `bash -p`: no BASH_ENV, ENV, imported
# functions, SHELLOPTS or BASHOPTS. The files in <dir> (an absolute path):
#   in.fifo    the console's framed lines: "\n<bytes> <id> <json>\n"
#   env        the program's environment, NUL-separated NAME=VALUE (host.ts removes it after start)
#   out.jsonl  the program's stdout, appended; the console reads it from its own offset
#   err.log    the program's stderr and the relay's notes
#   passed     the ids that the relay gave to the program (this start only), one per line
#   pid        "<pid> <starttime> <boot id>" of the program, written when it starts (the boot id:
#              a pid file of a boot before is not a live program)
#   exit       its exit code, written when it ends
#
# The relay gives the program only whole frames of the console's 2 shapes: claude ends at once on
# an input line that is not JSON (measured on 2.1.332). A line that a write cut (the console
# stopped in the middle) has the wrong length, and the relay drops it: the "\n" in front of the
# next frame ends it. A frame with an id that the relay gave already is dropped too (a resend).
# The console writes only printable ASCII (stream.ts escapes the rest), so a byte that is not
# printable ASCII is a fault. The relay does not parse the JSON: with one writer (the console's
# lock in host.ts) a frame of the right length is a frame that the console wrote whole.
# No program that a fresh install lacks: bash and its builtins, mv and env.
PATH=/usr/bin:/bin
um=$(umask) # the console's: the program gets it back (a terminal agent has it too)
umask 077   # the holder's own files: 0600
MAX=1048576 # the longest frame JSON, in bytes: HEADLESS_MAX_BYTES in stream.ts
dir=$1
shift

relay() {
  LC_ALL=C # ${#var} and read -n count bytes, as the console does (this subshell only)
  local line len rest id json lim=$((MAX + 128))
  local -A seen=()
  if [ -f "$dir/passed" ]; then
    while IFS= read -r id; do [ -n "$id" ] && seen[$id]=1; done < "$dir/passed"
  fi
  exec 4>> "$dir/passed"
  while IFS= read -r -n "$lim" line; do
    if [ "${#line}" -ge "$lim" ]; then # longer than any frame: drop it, to its end
      while IFS= read -r -n "$lim" line && [ "${#line}" -ge "$lim" ]; do :; done
      echo "relay: dropped a line above $MAX bytes" >&2
      continue
    fi
    [ -n "$line" ] || continue
    len=${line%% *}
    rest=${line#* }
    id=${rest%% *}
    json=${rest#* }
    case $len in
      '' | *[!0-9]* | ????????*) echo "relay: dropped a line that is not a frame (${#line} bytes)" >&2; continue ;;
    esac
    if [ "$len" -gt "$MAX" ] || [ "${#json}" -ne "$len" ] || [[ ! $id =~ ^[A-Za-z0-9-]{1,64}$ ]]; then
      echo "relay: dropped a cut line (${#line} bytes)" >&2
      continue
    fi
    case $json in
      '{"type":"user",'*'}' | '{"type":"control_request",'*'}') ;;
      *) echo "relay: dropped a frame that is not a message (${#line} bytes)" >&2; continue ;;
    esac
    if [[ $json == *[![:print:]]* ]]; then
      echo "relay: dropped a frame with a byte that is not printable ASCII (${#line} bytes)" >&2
      continue
    fi
    [ -z "${seen[$id]-}" ] || continue
    seen[$id]=1
    printf '%s\n' "$id" >&4
    printf '%s\n' "$json" || return # the program is gone
  done
}

case $dir in
  /*) ;;
  *) echo "holder: the folder is not an absolute path" >&2; exit 70 ;;
esac
if [ ! -d "$dir" ] || [ -L "$dir/in.fifo" ] || [ ! -p "$dir/in.fifo" ] || [ ! -f "$dir/env" ]; then
  echo "holder: no FIFO or no env file in the worker's folder" >&2
  exit 70
fi
envs=()
mapfile -d '' -t envs < "$dir/env" || exit 70
# Read-write: the open never waits for a writer, and the FIFO keeps its bytes while this holder
# lives (a FIFO drops its buffer when its last fd closes).
exec 3<> "$dir/in.fifo" || exit 70
# Ends a line that an earlier program cut (the console also starts a new file at each start).
printf '\n' >> "$dir/out.jsonl"
# Not a pipeline: `wait` on a pipe's last pid waits for the relay too, and the relay waits on the
# FIFO for ever. The program gets only the env file's environment, and the console's umask.
(umask "$um" && exec env -i -- "${envs[@]}" "$@") < <(relay <&3 2>> "$dir/err.log") 3<&- >> "$dir/out.jsonl" 2>> "$dir/err.log" & # 3<&- after <(…)
pid=$!
# Start time 0: the program ended before this read (the console then waits for the exit file).
stat=
read -r stat < "/proc/$pid/stat" 2> /dev/null
read -r -a f <<< "${stat##*) }"
boot=
read -r boot < /proc/sys/kernel/random/boot_id 2> /dev/null
printf '%s %s %s\n' "$pid" "${f[19]:-0}" "${boot:--}" > "$dir/pid.tmp" && mv -f "$dir/pid.tmp" "$dir/pid"
wait "$pid"
code=$?
printf '%s\n' "$code" > "$dir/exit.tmp" && mv -f "$dir/exit.tmp" "$dir/exit"
# The relay waits on the FIFO: end it, and this holder with it. A process of the program in
# another session lives on: the console stops the whole scope when it sees the exit.
trap '' TERM
kill 0
exit "$code"
