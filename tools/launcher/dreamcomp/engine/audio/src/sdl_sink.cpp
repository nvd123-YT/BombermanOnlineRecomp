// See sink.h.
// Audio output (WP2.5).
//
// The AICA produces one stereo sample per 44.1 kHz tick of the guest's virtual clock. The host's
// sound device consumes samples on its own real clock. Those two clocks are not the same, and
// everything awkward about audio output follows from that.
//
// This follows Flycast's audiostream.cpp (GPL-2.0, ADR 1): a fixed circular buffer of stereo
// samples, filled as the guest produces them, flushed to the audio device when full. Clock drift
// between guest and device is absorbed by the buffer depth, and gentle rate control nudges the
// playback ratio to keep the queue near target, preventing both underruns (audio cutting out)
// and overflows (wrap-around corruption).
//
// Reference: Flycast's core/audio/audiostream.cpp `WriteSample` / `AudioBackend::push`.
#include "dream/audio/sink.h"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace dream::audio {

Sink::~Sink() {
    close();
}

bool Sink::open(unsigned rate) {
    close();
    rate_ = rate;
    if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) {
        error_ = std::string("SDL_InitSubSystem(audio): ") + SDL_GetError();
        return false;
    }
    SDL_AudioSpec spec{};
    spec.format = SDL_AUDIO_S16;
    spec.channels = 2;
    spec.freq = static_cast<int>(rate);
    stream_ = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, nullptr, nullptr);
    if (!stream_) {
        error_ = std::string("SDL_OpenAudioDeviceStream: ") + SDL_GetError();
        return false;
    }
    if (!SDL_ResumeAudioStreamDevice(stream_)) {
        error_ = std::string("SDL_ResumeAudioStreamDevice: ") + SDL_GetError();
        close();
        return false;
    }
    buffer_.assign(kBufferFrames * 2, 0);
    write_pos_ = 0;
    return true;
}

void Sink::close() {
    if (stream_) {
        SDL_DestroyAudioStream(stream_);
        stream_ = nullptr;
    }
    buffer_.clear();
    write_pos_ = 0;
}

unsigned Sink::queued_samples() const {
    if (!stream_)
        return 0;
    const int bytes = SDL_GetAudioStreamQueued(stream_);
    if (bytes <= 0)
        return 0;
    return static_cast<unsigned>(bytes) / 4u;  // 16-bit stereo
}

// Apply volume the way Flycast's WriteSample does: config::AudioVolume.dbPower() per sample.
static inline std::int16_t apply_volume(std::int16_t s, unsigned vol) {
    if (vol == 256)
        return s;
    const int v = static_cast<int>(s) * static_cast<int>(vol) / 256;
    return static_cast<std::int16_t>(std::clamp(v, -32768, 32767));
}

void Sink::push(std::int16_t left, std::int16_t right) {
    if (!stream_)
        return;

    // Apply per-sample volume (Flycast's WriteSample: Buffer[writePtr] = value * volume).
    buffer_[write_pos_ * 2]     = apply_volume(left, volume);
    buffer_[write_pos_ * 2 + 1] = apply_volume(right, volume);
    ++write_pos_;
    ++pushed;

    // Push to the device in small chunks (~256 frames = ~6ms at 44.1 kHz). Small chunks keep
    // latency low and let rate control react quickly to clock drift between the guest and the
    // device. Only push the frames that have actually been written.
    if (write_pos_ < kPushFrames)
        return;

    const unsigned queued = queued_samples();
    if (queued == 0 && blocks > 0)
        ++underruns;

    // Gentle rate control: nudge playback ratio to hold the queue near target. Above target:
    // play slightly faster. Below target: play slightly slower. This prevents both underruns
    // (queue runs dry, audio cuts out) and overflows (queue wraps, corrupting audio).
    if (rate_control && target > 0) {
        const float error = (static_cast<float>(queued) - static_cast<float>(target)) /
                            static_cast<float>(target);
        float r = 1.0f + std::clamp(error * max_skew, -max_skew, max_skew);
        if (std::abs(r - ratio) > 0.0002f) {
            SDL_SetAudioStreamFrequencyRatio(stream_, r);
            ratio = r;
        }
    }

    // Overflow protection: if the device is backed up more than half the buffer, pause writing
    // until it catches up rather than wrapping around and corrupting unplayed data.
    if (queued > kBufferFrames / 2) {
        write_pos_ = 0;
        return;
    }

    const std::size_t push_frames = write_pos_;
    SDL_PutAudioStreamData(stream_, buffer_.data(),
                           static_cast<int>(push_frames * 2 * sizeof(std::int16_t)));
    ++blocks;
    write_pos_ = 0;
}

void Sink::flush() {
    if (!stream_ || write_pos_ == 0)
        return;
    SDL_PutAudioStreamData(stream_, buffer_.data(),
                           static_cast<int>(write_pos_ * 2 * sizeof(std::int16_t)));
    ++blocks;
    write_pos_ = 0;
}

}  // namespace dream::audio
