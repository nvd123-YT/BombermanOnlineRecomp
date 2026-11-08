// See sink.h.
// Audio output (WP2.5).
//
// The AICA produces one stereo sample per 44.1 kHz tick of the guest's virtual clock. The host's
// sound device consumes samples on its own real clock. Those two clocks are not the same, and
// everything awkward about audio output follows from that.
//
// This follows Flycast's audiostream.cpp (GPL-2.0, ADR 1): a fixed circular buffer of stereo
// samples is filled as the guest produces them, and the buffer is flushed to the audio device
// when full. This keeps the guest and device loosely coupled - clock drift is absorbed by the
// buffer depth, and occasional underruns/overflows are handled gracefully.
//
// Reference: Flycast's core/audio/audiostream.cpp `WriteSample` / `AudioBackend::push`.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

struct SDL_AudioStream;

namespace dream::audio {

class Sink {
public:
    Sink() = default;
    ~Sink();
    Sink(const Sink&) = delete;
    Sink& operator=(const Sink&) = delete;

    // Opens the default playback device as 16-bit stereo at `rate`. False with error() set when
    // there is no device.
    bool open(unsigned rate = 44100);
    void close();
    bool is_open() const noexcept { return stream_ != nullptr; }

    // One stereo sample from the AICA. Buffered in the circular buffer; when it fills, the whole
    // buffer is sent to the device (Flycast's WriteSample / push pattern).
    void push(std::int16_t left, std::int16_t right);
    // Sends whatever is buffered, whether or not it fills a block. For the end of a run.
    void flush();

    // How many samples the device still has to play.
    unsigned queued_samples() const;

    // Volume applied to every sample (0 = mute, 256 = unity, higher = boost).
    // Mirrors Flycast's per-sample volume scaling in WriteSample.
    unsigned volume = 256;

    // Dynamically nudge playback ratio to keep the queue near `target`. Enabled by default to
    // prevent underruns (audio cutting out) when the guest runs slower than real time, and
    // overflows (wrap-around corruption) when it runs faster.
    bool rate_control = true;
    unsigned target = 3072;   // ~70 ms at 44.1 kHz: absorbs clock drift without audible lag
    float max_skew = 0.02f;   // 2%: enough to track drift quickly

    std::uint64_t pushed = 0, dropped = 0, blocks = 0, underruns = 0, overflows = 0;
    float ratio = 1.0f;
    const std::string& error() const noexcept { return error_; }

private:
    // Fixed circular buffer (Flycast's SoundFrame Buffer[SAMPLE_COUNT]).
    static constexpr std::size_t kBufferFrames = 4096;  // ~93 ms at 44.1 kHz
    static constexpr std::size_t kPushFrames = 1024;    // ~23 ms per push to the device

    SDL_AudioStream* stream_ = nullptr;
    std::vector<std::int16_t> buffer_;  // kBufferFrames * 2 samples
    std::size_t write_pos_ = 0;         // frames written into buffer_
    unsigned rate_ = 44100;
    std::string error_;
};

}  // namespace dream::audio
