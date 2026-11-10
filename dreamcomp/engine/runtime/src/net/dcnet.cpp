#include "dream/runtime/net/dcnet.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace dream::net {
namespace {

#ifdef _WIN32
using NativeSocket = SOCKET;
constexpr NativeSocket kInvalidSocket = INVALID_SOCKET;
void close_socket(NativeSocket s) {
    if (s != kInvalidSocket) closesocket(s);
}
void shutdown_socket(NativeSocket s) {
    if (s != kInvalidSocket) ::shutdown(s, SD_BOTH);
}
int last_socket_error() { return WSAGetLastError(); }
bool would_block(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
void ensure_winsock() {
    static const bool ready = [] {
        WSADATA data{};
        return WSAStartup(MAKEWORD(2, 2), &data) == 0;
    }();
    (void)ready;
}
#else
using NativeSocket = int;
constexpr NativeSocket kInvalidSocket = -1;
void close_socket(NativeSocket s) {
    if (s != kInvalidSocket) ::close(s);
}
void shutdown_socket(NativeSocket s) {
    if (s != kInvalidSocket) ::shutdown(s, SHUT_RDWR);
}
int last_socket_error() { return errno; }
bool would_block(int e) { return e == EWOULDBLOCK || e == EINPROGRESS || e == EAGAIN; }
void ensure_winsock() {}
#endif

constexpr std::uint32_t kMagic = 0xDC15C001u;
constexpr std::uint8_t kDiscover = 3;
constexpr std::uint16_t kDcNetPort = 7655;
constexpr std::size_t kMaxFrame = 1600;

// A blocking TCP connect with a bounded wait, so a wrong server name fails the launch instead of
// hanging it. The socket is left blocking afterwards for the reader/writer threads.
NativeSocket connect_tcp(const std::string& host, std::uint16_t port, std::string& error) {
    ensure_winsock();
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    addrinfo* result = nullptr;
    const std::string service = std::to_string(port);
    if (getaddrinfo(host.c_str(), service.c_str(), &hints, &result) != 0 || result == nullptr) {
        error = "cannot resolve " + host;
        return kInvalidSocket;
    }
    NativeSocket sock = kInvalidSocket;
    for (addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
        sock = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (sock == kInvalidSocket)
            continue;
#ifdef _WIN32
        u_long nonblocking = 1;
        ioctlsocket(sock, FIONBIO, &nonblocking);
#else
        const int flags = fcntl(sock, F_GETFL, 0);
        fcntl(sock, F_SETFL, flags | O_NONBLOCK);
#endif
        const int rc = ::connect(sock, ai->ai_addr, static_cast<int>(ai->ai_addrlen));
        bool ok = rc == 0;
        if (!ok && would_block(last_socket_error())) {
            fd_set writable;
            FD_ZERO(&writable);
            FD_SET(static_cast<NativeSocket>(sock), &writable);
            timeval timeout{};
            timeout.tv_sec = 5;
            const int ready = ::select(static_cast<int>(sock) + 1, nullptr, &writable, nullptr, &timeout);
            if (ready > 0) {
                int so_error = 0;
                socklen_t len = sizeof(so_error);
                if (getsockopt(sock, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_error), &len) == 0 &&
                    so_error == 0)
                    ok = true;
            }
        }
        if (ok) {
            // Back to blocking: the reader waits in recv, the writer in send.
#ifdef _WIN32
            nonblocking = 0;
            ioctlsocket(sock, FIONBIO, &nonblocking);
#else
            fcntl(sock, F_SETFL, flags);
#endif
            const int one = 1;
            setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&one), sizeof(one));
            break;
        }
        close_socket(sock);
        sock = kInvalidSocket;
    }
    freeaddrinfo(result);
    if (sock == kInvalidSocket)
        error = "cannot connect to " + host + ":" + service;
    return sock;
}

}  // namespace

DcNetClient::~DcNetClient() { stop(); }

bool DcNetClient::start(const std::string& host, std::uint16_t port, Mode mode, std::string& error) {
    if (running_.load())
        return true;
    const NativeSocket sock = connect_tcp(host, port, error);
    if (sock == kInvalidSocket)
        return false;

    socket_ = static_cast<Socket>(sock);
    mode_.store(mode, std::memory_order_release);
    // BBA reconnects always target the same endpoint. Keeping the established label stable avoids
    // racing report/UI readers with redundant string assignments on every retry.
    if (endpoint_.empty())
        endpoint_ = host + ":" + std::to_string(port);
    stop_.store(false);
    connected_.store(true);
    running_.store(true);

    if (mode == Mode::Ethernet) {
        // The access point expects the prolog itself inside the same 2-byte length framing it
        // uses for Ethernet frames. Flycast's EthSocket sends it through send(), which prepends
        // the length, so the wire bytes are 06 00 'D' 'C' 'N' 'E' 'T' 01. Sending the six bytes
        // raw makes the server drop the connection.
        static constexpr std::uint8_t kProlog[] = {0x06, 0x00, 'D', 'C', 'N', 'E', 'T', 1};
        std::size_t sent = 0;
        while (sent < sizeof(kProlog)) {
            const auto n = ::send(sock, reinterpret_cast<const char*>(kProlog + sent),
                                  static_cast<int>(sizeof(kProlog) - sent), 0);
            if (n <= 0) {
                fail();
                stop();
                error = "cannot send the DCNet prolog to " + endpoint_;
                return false;
            }
            sent += static_cast<std::size_t>(n);
        }
    }

    reader_ = std::thread(&DcNetClient::reader_main, this);
    writer_ = std::thread(&DcNetClient::writer_main, this);
    return true;
}

void DcNetClient::stop() {
    running_.store(false);
    stop_.store(true);
    {
        std::lock_guard<std::mutex> lock(tx_mutex_);
        tx_.clear();
    }
    tx_cv_.notify_all();
    shutdown_socket(static_cast<NativeSocket>(socket_));
    if (reader_.joinable())
        reader_.join();
    if (writer_.joinable())
        writer_.join();
    close_socket(static_cast<NativeSocket>(socket_));
    socket_ = -1;
    connected_.store(false);
}

void DcNetClient::fail() {
    connected_.store(false);
    running_.store(false);
    stop_.store(true);
    tx_cv_.notify_all();
    shutdown_socket(static_cast<NativeSocket>(socket_));
}

void DcNetClient::send_frame(const std::uint8_t* frame, std::size_t size) {
    if (frame == nullptr || size == 0 || size > kMaxFrame)
        return;
    {
        std::lock_guard<std::mutex> lock(tx_mutex_);
        // Recheck while holding the queue lock: a sender must not enqueue after stop() clears it.
        if (!running_.load(std::memory_order_acquire) ||
            mode_.load(std::memory_order_acquire) != Mode::Ethernet)
            return;
        tx_.push_back(static_cast<std::uint8_t>(size & 0xFF));
        tx_.push_back(static_cast<std::uint8_t>((size >> 8) & 0xFF));
        tx_.insert(tx_.end(), frame, frame + size);
    }
    tx_cv_.notify_one();
}

void DcNetClient::send_byte(std::uint8_t b) {
    {
        std::lock_guard<std::mutex> lock(tx_mutex_);
        if (!running_.load(std::memory_order_acquire) ||
            mode_.load(std::memory_order_acquire) != Mode::Ppp)
            return;
        tx_.push_back(b);
    }
    tx_cv_.notify_one();
}

void DcNetClient::writer_main() {
    const NativeSocket sock = static_cast<NativeSocket>(socket_);
    std::vector<std::uint8_t> chunk;
    while (!stop_.load()) {
        {
            std::unique_lock<std::mutex> lock(tx_mutex_);
            tx_cv_.wait_for(lock, std::chrono::milliseconds(100),
                            [this] { return stop_.load() || !tx_.empty(); });
            if (stop_.load())
                break;
            if (tx_.empty())
                continue;
            chunk.assign(tx_.begin(), tx_.end());
            tx_.clear();
        }
        std::size_t sent = 0;
        while (sent < chunk.size()) {
            const auto n = ::send(sock, reinterpret_cast<const char*>(chunk.data() + sent),
                                  static_cast<int>(chunk.size() - sent), 0);
            if (n <= 0) {
                fail();
                return;
            }
            sent += static_cast<std::size_t>(n);
        }
    }
}

void DcNetClient::reader_main() {
    const NativeSocket sock = static_cast<NativeSocket>(socket_);
    std::array<std::uint8_t, 4096> buffer{};
    while (!stop_.load()) {
        const auto n = ::recv(sock, reinterpret_cast<char*>(buffer.data()),
                              static_cast<int>(buffer.size()), 0);
        if (n <= 0)
            break;
        std::lock_guard<std::mutex> lock(rx_mutex_);
        if (mode_.load(std::memory_order_acquire) == Mode::Ppp) {
            if (byte_handler_) {
                for (int i = 0; i < n; ++i) byte_handler_(buffer[static_cast<std::size_t>(i)]);
            }
        } else {
            rx_.insert(rx_.end(), buffer.begin(), buffer.begin() + n);
            parse_ethernet(rx_.data(), rx_.size());
        }
    }
    if (!stop_.load())
        fail();
}

// Ethernet frames arrive as: 2-byte little-endian length, then that many bytes. A partial frame
// stays in the buffer until the rest arrives.
void DcNetClient::parse_ethernet(const std::uint8_t* data, std::size_t size) {
    std::size_t offset = 0;
    while (size - offset >= 2) {
        const std::size_t length =
            static_cast<std::size_t>(data[offset]) | (static_cast<std::size_t>(data[offset + 1]) << 8);
        if (length == 0 || length > kMaxFrame) {
            rx_.clear();
            fail();
            return;
        }
        if (size - offset - 2 < length)
            break;
        if (frame_handler_) {
            if (verbose_) {
                std::printf("dcnet: rx %zu bytes:", length);
                for (std::size_t i = 0; i < length && i < 128; ++i)
                    std::printf(" %02x", data[offset + 2 + i]);
                if (length > 128)
                    std::printf(" ...");
                std::printf("\n");
            }
            frame_handler_(data + offset + 2, length);
        }
        offset += 2 + length;
    }
    if (offset > 0)
        rx_.erase(rx_.begin(), rx_.begin() + static_cast<std::ptrdiff_t>(offset));
}

bool DcNetClient::discover(std::string& host, std::uint16_t port, std::string& error) {
    ensure_winsock();
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_protocol = IPPROTO_UDP;
    addrinfo* result = nullptr;
    const std::string service = std::to_string(port == 0 ? kDcNetPort : port);
    if (getaddrinfo(host.empty() ? "dcnet.flyca.st" : host.c_str(), service.c_str(), &hints, &result) != 0 ||
        result == nullptr) {
        error = "cannot resolve the DCNet directory";
        return false;
    }
    const NativeSocket sock = ::socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (sock == kInvalidSocket) {
        freeaddrinfo(result);
        error = "cannot open a DCNet discovery socket";
        return false;
    }
    std::array<std::uint8_t, 5> request{};
    std::memcpy(request.data(), &kMagic, sizeof(kMagic));
    request[4] = kDiscover;
    ::sendto(sock, reinterpret_cast<const char*>(request.data()), static_cast<int>(request.size()), 0,
             result->ai_addr, static_cast<int>(result->ai_addrlen));

    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(sock, &readable);
    timeval timeout{};
    timeout.tv_sec = 1;
    bool found = false;
    std::string chosen;
    if (::select(static_cast<int>(sock) + 1, &readable, nullptr, nullptr, &timeout) > 0) {
        std::array<std::uint8_t, 512> reply{};
        sockaddr_storage from{};
        socklen_t from_len = static_cast<socklen_t>(sizeof(from));
        const auto n = ::recvfrom(sock, reinterpret_cast<char*>(reply.data()),
                                  static_cast<int>(reply.size()), 0, reinterpret_cast<sockaddr*>(&from),
                                  &from_len);
        if (n >= 5 && std::memcmp(reply.data(), &kMagic, sizeof(kMagic)) == 0 && reply[4] == kDiscover) {
            // The directory answers with a list of (IPv4 address, name length, name) entries.
            int p = 5;
            while (p + 4 <= n) {
                std::uint32_t address = 0;
                std::memcpy(&address, reply.data() + p, sizeof(address));
                p += 4;
                const std::size_t name_length = reply[static_cast<std::size_t>(p)];
                ++p;
                if (p + static_cast<int>(name_length) > n)
                    break;
                const std::string name(reinterpret_cast<const char*>(reply.data() + p), name_length);
                p += static_cast<int>(name_length);
                if (!found) {
                    char text[INET_ADDRSTRLEN] = {};
                    in_addr addr{};
                    addr.s_addr = address;
                    if (inet_ntop(AF_INET, &addr, text, sizeof(text)) != nullptr) {
                        chosen = text;
                        found = true;
                    }
                }
                (void)name;
            }
        }
    }
    close_socket(sock);
    if (!found) {
        // No list: connect to the directory itself, which is also a DCNet access point.
        char text[INET_ADDRSTRLEN] = {};
        const sockaddr_in* v4 = reinterpret_cast<const sockaddr_in*>(result->ai_addr);
        if (inet_ntop(AF_INET, &v4->sin_addr, text, sizeof(text)) != nullptr)
            chosen = text;
    }
    freeaddrinfo(result);
    if (chosen.empty()) {
        error = "the DCNet directory did not answer";
        return false;
    }
    host = chosen;
    return true;
}

}  // namespace dream::net
