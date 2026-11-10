// DCNet: the network transport Flycast uses for Dreamcast online play. The BBA path speaks the
// Ethernet framing of a DCNet access point ("DCNET\1" prolog, then a 2-byte little-endian length
// and the frame); the modem path is a raw PPP byte stream on the same host, port 7654.
//
// The transport owns two host threads (one reading, one writing) so the emulation thread never
// blocks on a socket. Frames arrive through a callback invoked on the reader thread; the BBA
// device queues them and hands them to the chip from the virtual clock.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace dream::net {

class DcNetClient {
public:
    // Called on the reader thread with one complete Ethernet frame (BBA) or one byte (modem).
    using FrameHandler = std::function<void(const std::uint8_t*, std::size_t)>;
    using ByteHandler = std::function<void(std::uint8_t)>;

    enum class Mode { Ethernet, Ppp };

    DcNetClient() = default;
    ~DcNetClient();
    DcNetClient(const DcNetClient&) = delete;
    DcNetClient& operator=(const DcNetClient&) = delete;

    // Connects to `host:port` and starts the reader/writer threads. `mode` selects the framing:
    // Ethernet sends the DCNET prolog and length-prefixed frames, Ppp is a raw byte stream.
    // Returns false and fills `error` when the connection cannot be made.
    bool start(const std::string& host, std::uint16_t port, Mode mode, std::string& error);
    // Closes the socket and joins both threads. Safe to call more than once.
    void stop();

    bool running() const noexcept { return running_.load(std::memory_order_acquire); }
    bool connected() const noexcept { return connected_.load(std::memory_order_acquire); }
    const std::string& endpoint() const noexcept { return endpoint_; }

    // Queues one frame for transmission (Ethernet mode only). Never blocks.
    void send_frame(const std::uint8_t* frame, std::size_t size);
    // Queues one byte (Ppp mode only). Never blocks.
    void send_byte(std::uint8_t b);

    void set_frame_handler(FrameHandler handler) { frame_handler_ = std::move(handler); }
    void set_byte_handler(ByteHandler handler) { byte_handler_ = std::move(handler); }
    void set_verbose(bool v) { verbose_ = v; }

    // Asks the DCNet directory (dcnet.flyca.st:7655) for access points and fills `host` with the
    // first one it answers from. Falls back to the directory's own address when no list arrives,
    // which is what Flycast does. Blocking, with a one-second budget; call before start().
    static bool discover(std::string& host, std::uint16_t port, std::string& error);

private:
    using Socket = std::intptr_t;

    bool connect_socket(std::string& error);
    void reader_main();
    void writer_main();
    void parse_ethernet(const std::uint8_t* data, std::size_t size);
    void fail();

    Socket socket_ = -1;
    std::atomic<Mode> mode_{Mode::Ethernet};
    std::string endpoint_;
    bool verbose_ = false;

    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    std::atomic<bool> stop_{false};

    std::thread reader_, writer_;

    std::mutex tx_mutex_;
    std::condition_variable tx_cv_;
    std::deque<std::uint8_t> tx_;

    std::vector<std::uint8_t> rx_;
    std::mutex rx_mutex_;

    FrameHandler frame_handler_;
    ByteHandler byte_handler_;
};

}  // namespace dream::net
