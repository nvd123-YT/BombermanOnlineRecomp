// The Broadband Adapter: the GAPSPCI bridge, a minimal RTL8139C and its 32 KB SRAM, mapped in the
// Ext. Device area at 0x01000000 (uncached 0xA1000000). This is the hardware Bomberman Online
// drives directly: it programs BAR1 and the RTL registers and expects Ethernet frames to move.
//
// Layout, from Flycast's bba/bba.cpp (GPL-2.0, ADR 1):
//   0x01001400  GAPSPCI bridge registers (0x200)
//   0x01001600  PCI configuration space of the RTL8139 (0x100)
//   0x01001700  RTL8139 registers (0x100)
//   0x01840000  BBA SRAM (0x8000), also reachable through the G2 DMA window
//
// Received frames are queued by the transport's reader thread and handed to the chip from the
// virtual clock, exactly as Flycast does, because the RTL state and the interrupt controller belong
// to the emulation thread.
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include "dream/runtime/holly/intc.h"
#include "dream/runtime/mem/dc_memory.h"
#include "dream/runtime/net/dcnet.h"
#include "dream/runtime/sched/scheduler.h"

namespace dream::hw {

class Bba final : public mem::MmioHandler {
public:
    static constexpr std::uint32_t kBase = 0x01000000u;
    static constexpr std::uint32_t kEnd = 0x01880000u;

    struct Config {
        std::string server = "dcnet.flyca.st";
        std::uint16_t port = 7655;
        // Ask the DCNet directory for an access point before connecting. Off by default: the
        // directory itself accepts the connection, and that keeps the launch path short.
        bool discover = false;
        bool verbose = false;
    };

    Bba(sched::Scheduler& sched, holly::Intc& intc, Config config);
    ~Bba() override;
    Bba(const Bba&) = delete;
    Bba& operator=(const Bba&) = delete;

    void reset();
    void reset_rtl();
    // Arms the virtual-clock receive poll; call after the device is mapped.
    void start();

    std::uint32_t read(std::uint32_t addr, unsigned size) override;
    void write(std::uint32_t addr, std::uint32_t value, unsigned size) override;

    // Run-report counters.
    std::uint64_t rx_frames = 0, tx_frames = 0;
    std::atomic<std::uint64_t> rx_dropped{0};
    bool online_started() const noexcept { return online_started_; }
    bool online_connected() const noexcept { return net_.connected(); }
    const std::string& online_endpoint() const noexcept { return net_.endpoint(); }

private:
    static constexpr std::uint32_t kGapsBase = 0x001400u, kGapsSize = 0x200u;
    static constexpr std::uint32_t kPciBase = 0x001600u, kPciSize = 0x100u;
    static constexpr std::uint32_t kRtlBase = 0x001700u, kRtlSize = 0x100u;
    static constexpr std::uint32_t kSramOffset = 0x840000u, kSramSize = 0x8000u;

    // GAPSPCI registers
    static constexpr std::uint32_t kGapsIntEnable = 0x14u;
    static constexpr std::uint32_t kGapsReset = 0x18u;
    static constexpr std::uint32_t kGapsDmaOffset = 0x2Cu;

    // RTL8139 register offsets
    enum : std::uint32_t {
        kMac0 = 0x00,
        kMar0 = 0x08,
        kTxStatus0 = 0x10,
        kTxAddr0 = 0x20,
        kRxBuf = 0x30,
        kRxBufPtr = 0x34,
        kRxBufAddr = 0x36,
        kChipCmd = 0x37,
        kIntrMask = 0x3C,
        kIntrStatus = 0x3E,
        kTxConfig = 0x40,
        kRxConfig = 0x44,
        kCfg9346 = 0x50,
        kConfig0 = 0x51,
        kConfig1 = 0x52,
        kConfig3 = 0x54,
        kConfig4 = 0x55,
        kConfig5 = 0x56,
        kMediaStatus = 0x58,
        kBasicModeCtrl = 0x62,
        kBasicModeStatus = 0x64,
        kNWayAdvert = 0x66,
        kNWayLPAR = 0x68,
        kNWayExpansion = 0x6A,
        kTxSummary = 0x60,
        kCSCR = 0x74,
        kHltClk = 0x75,
        kRxMissed = 0xBC,
        kTxPoll = 0xD9,
        kCpCmd = 0xE0,
        kRxRingAddrLo = 0xE4,
        kRxRingAddrHi = 0xE8,
        kIntrMitigate = 0xEC,
        kTxThresh = 0xEC,
        kTimer = 0x48,
        kMultiIntr = 0x5C,
        kPciRevisionId = 0x5E,
    };

    // RTL bits
    enum : std::uint8_t { kCmdReset = 0x10, kCmdRxEnb = 0x08, kCmdTxEnb = 0x04 };
    enum : std::uint16_t {
        kIntrRxOk = 0x01,
        kIntrTxOk = 0x04,
        kIntrRxOverflow = 0x10,
        kIntrRxUnderrun = 0x20,
    };
    enum : std::uint32_t {
        kTxHostOwns = 0x2000,
        kTxStatOk = 0x8000,
        kRxStatusOk = 0x0001,
        kRxBroadcast = 0x2000,
        kRxPhysical = 0x4000,
        kRxMulticast = 0x8000,
        kAcceptBroadcast = 0x08,
        kAcceptMulticast = 0x04,
        kAcceptMyPhys = 0x02,
        kAcceptAllPhys = 0x01,
    };

    // EEPROM 9346
    enum class EepromMode {
        None,
        EnterCommand,
        ReadCommand,
        DataRead,
        DataWrite,
        DataWriteAll,
    };

    std::uint32_t sram_read(std::uint32_t addr, unsigned size);
    void sram_write(std::uint32_t addr, std::uint32_t value, unsigned size);
    void dma_read(std::uint32_t addr, std::uint8_t* out, std::size_t size);
    void dma_write(std::uint32_t addr, const std::uint8_t* in, std::size_t size);

    std::uint32_t rtl_read(std::uint32_t off, unsigned size);
    void rtl_write(std::uint32_t off, std::uint32_t value, unsigned size);
    std::uint32_t read8(std::uint32_t off);
    std::uint32_t read16(std::uint32_t off);
    std::uint32_t read32(std::uint32_t off);
    void write8(std::uint32_t off, std::uint32_t value);
    void write16(std::uint32_t off, std::uint32_t value);
    void write32(std::uint32_t off, std::uint32_t value);

    void update_irq();
    void set_interrupt();
    bool receiver_enabled() const noexcept { return (chip_cmd_ & kCmdRxEnb) != 0; }
    bool transmitter_enabled() const noexcept { return (chip_cmd_ & kCmdTxEnb) != 0; }
    bool can_receive();
    bool receive(const std::uint8_t* frame, std::size_t size);
    void receive_write(const std::uint8_t* data, std::size_t size);
    void transmit();
    bool transmit_one(unsigned descriptor);
    void ensure_online();
    void reset_rx_ring(std::uint32_t size);

    // EEPROM bit-banging
    void cfg9346_write(std::uint32_t value);
    std::uint32_t cfg9346_read();
    void prom_set_wire(int cs, int sk, int di);
    void prom_shift_clock();
    void prom_decode(std::uint8_t command);

    // RX delivery from the virtual clock
    void poll_rx();

    sched::Scheduler& sched_;
    holly::Intc& intc_;
    Config config_;
    net::DcNetClient net_;
    int poll_event_ = -1;
    bool online_started_ = false;

    std::array<std::uint8_t, kGapsSize> gaps_{};
    std::array<std::uint8_t, kPciSize> pci_{};
    std::array<std::uint8_t, kSramSize> sram_{};
    std::uint32_t dma_offset_ = 0;
    bool interrupt_pending_ = false;

    // RTL8139 state
    std::array<std::uint8_t, 6> mac_{};
    std::array<std::uint8_t, 8> mar_{};
    std::array<std::uint32_t, 4> tx_status_{};
    std::array<std::uint32_t, 4> tx_addr_{};
    std::uint32_t rx_buf_ = 0;
    std::uint32_t rx_buf_ptr_ = 0;
    std::uint32_t rx_buf_addr_ = 0;
    std::uint32_t rx_buffer_size_ = 8192;
    std::uint8_t chip_cmd_ = 0;
    std::uint16_t intr_mask_ = 0;
    std::uint16_t intr_status_ = 0;
    std::uint16_t multi_intr_ = 0;
    std::uint32_t tx_config_ = 0;
    std::uint32_t rx_config_ = 0;
    std::uint8_t cfg9346_ = 0;
    std::uint8_t config0_ = 0, config1_ = 0, config3_ = 0, config4_ = 0, config5_ = 0;
    std::uint16_t basic_mode_ctrl_ = 0, basic_mode_status_ = 0;
    std::uint16_t nway_advert_ = 0, nway_lpar_ = 0, nway_expansion_ = 0;
    std::uint16_t cscr_ = 0;
    std::uint32_t rx_missed_ = 0;
    std::uint32_t curr_tx_desc_ = 0;
    bool clock_enabled_ = true;

    std::array<std::uint16_t, 64> eeprom_{};
    EepromMode eeprom_mode_ = EepromMode::None;
    std::uint32_t eeprom_tick_ = 0;
    std::uint8_t eeprom_address_ = 0;
    std::uint16_t eeprom_input_ = 0, eeprom_output_ = 0;
    std::uint8_t eeprom_cs_ = 0, eeprom_sk_ = 0, eeprom_di_ = 0, eeprom_do_ = 0;

    std::mutex rx_mutex_;
    std::deque<std::vector<std::uint8_t>> rx_queue_;
    std::atomic<bool> rx_pending_{false};
};

}  // namespace dream::hw
