#!/usr/bin/env bash
# Transcode generated audio/video for the web (ffmpeg).
set -euo pipefail
cd "$(dirname "$0")/.."
G=assets/generated; O=public/assets
mkdir -p $O/audio/music $O/audio/sfx $O/audio/voice $O/video
for f in $G/music/*.mp3; do ffmpeg -loglevel error -y -i "$f" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -b:a 128k "$O/audio/music/$(basename "$f")"; done
for f in $G/sfx/*.mp3; do ffmpeg -loglevel error -y -i "$f" -af "loudnorm=I=-18:TP=-1.5" -ac 1 -ar 44100 -b:a 96k "$O/audio/sfx/$(basename "$f")"; done
for f in $G/voice/*.mp3; do ffmpeg -loglevel error -y -i "$f" -af "highpass=f=180,lowpass=f=5200,acompressor=threshold=-20dB:ratio=3,loudnorm=I=-15:TP=-1.5" -ac 1 -ar 44100 -b:a 96k "$O/audio/voice/$(basename "$f")"; done
mkdir -p $O/audio/talk
for f in $G/talk/*.mp3; do ffmpeg -loglevel error -y -i "$f" -af "highpass=f=120,loudnorm=I=-16:TP=-1.5" -ac 1 -ar 44100 -b:a 80k "$O/audio/talk/$(basename "$f")"; done
# cinematic videos at 720p, billboard clips at 480p (they are textures), all muted, faststart
for v in intro stinger loading_loop; do
  ffmpeg -loglevel error -y -i $G/video/$v.mp4 -vf "scale=-2:720" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -an -movflags +faststart $O/video/$v.mp4
  ffmpeg -loglevel error -y -i $G/video/$v.mp4 -vframes 1 -vf "scale=-2:720" -q:v 4 $O/video/$v.jpg
done
for v in bb_koi bb_drink bb_ramen bb_eye; do
  ffmpeg -loglevel error -y -i $G/video/$v.mp4 -vf "scale=-2:480" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -an -movflags +faststart $O/video/$v.mp4
done
du -sh $O/audio $O/video
