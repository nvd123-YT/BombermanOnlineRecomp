#include "dream/runtime/hw/bba.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <utility>

namespace dream::hw {
namespace {

constexpr std::uint32_t kEepromSize = 64;
constexpr std::uint32_t kEepromAddrMask = kEepromSize - 1;
constexpr std::size_t kMaxEthFrame = 1514;
constexpr std::size_t kMinEthFrame = 60;
constexpr std::size_t kRxQueueMax = 64;
constexpr std::uint64_t kRxPollCycles = 200'000;  // 1 ms of SH-4 time

inline std::uint32_t mod2(std::uint32_t a, std::uint32_t b) { return a % b; }
inline std::uint32_t rx_align(std::uint32_t x) { return (x + 3u) & ~3u; }

// SET_MASKED(old, mask, new): bits in `mask` keep the old value, the rest take the new one.
inline std::uint32_t set_masked(std::uint32_t old_value, std::uint32_t mask, std::uint32_t new_value) {
    return (old_value & ~mask) | (new_value & mask);
}

std::uint32_t crc32_ieee(const std::uint8_t* data, std::size_t size) {
    std::uint32_t crc = 0xFFFFFFFFu;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

}  // namespace

Bba::Bba(sched::Scheduler& sched, holly::Intc& intc, Config config)
    : sched_(sched), intc_(intc), config_(std::move(config)) {
    net_.set_frame_handler([this](const std::uint8_t* frame, std::size_t size) {
        if (size < 6 || size > kMaxEthFrame)
            return;
        {
            std::lock_guard<std::mutex> lock(rx_mutex_);
            if (rx_queue_.size() >= kRxQueueMax) {
                rx_dropped.fetch_add(1, std::memory_order_relaxed);
                return;
            }
            rx_queue_.emplace_back(frame, frame + size);
        }
        rx_pending_.store(true, std::memory_order_release);
    });
    net_.set_verbose(config_.verbose);
    reset();
    reconnect_thread_ = std::thread(&Bba::reconnect_main, this);
}

Bba::~Bba() {
    {
        std::lock_guard<std::mutex> lock(reconnect_mutex_);
        reconnect_shutdown_ = true;
        reconnect_ready_ = false;
        online_started_.store(false, std::memory_order_release);
    }
    reconnect_cv_.notify_all();
    if (reconnect_thread_.joinable())
        reconnect_thread_.join();
    if (poll_event_ >= 0)
        sched_.cancel(poll_event_);
    {
        std::lock_guard<std::mutex> lock(net_control_mutex_);
        net_.stop();
    }
}

void Bba::start() {
    if (poll_event_ >= 0)
        return;
    poll_event_ = sched_.add("bba-rx", [this](std::uint64_t, std::uint64_t) {
        poll_rx();
        sched_.request(poll_event_, kRxPollCycles);
    });
    sched_.request(poll_event_, kRxPollCycles);
}

void Bba::reset() {
    gaps_.fill(0);
    std::memcpy(gaps_.data(), "GAPSPCI_BRIDGE_2", 16);
    std::memcpy(gaps_.data() + 0x1C, "SEGA", 4);

    pci_.fill(0);
    // A real RTL8139C in a Dreamcast: Realtek vendor/device, Ethernet class, BAR0 an I/O window and
    // BAR1 the memory window the game programs to 0x01000000.
    pci_[0x00] = 0xEC;
    pci_[0x01] = 0x10;
    pci_[0x02] = 0x39;
    pci_[0x03] = 0x81;
    pci_[0x06] = 0x80;
    pci_[0x07] = 0x02;
    pci_[0x08] = 0x10;
    pci_[0x0B] = 0x02;
    pci_[0x10] = 0x01;
    pci_[0x17] = 0x01;  // BAR1 = 0x01000000
    pci_[0x3D] = 0x01;

    sram_.fill(0);
    dma_offset_ = 0;
    interrupt_pending_ = false;
    {
        std::lock_guard<std::mutex> lock(rx_mutex_);
        rx_queue_.clear();
    }
    rx_pending_.store(false);
    reset_rtl();
}

void Bba::reset_rtl() {
    if (config_.verbose)
        std::printf("bba: rtl8139 reset\n");
    mac_ = {0x0C, 0x0A, 0x0F, 0x0E, 0x00, 0x00};
    mar_.fill(0);
    tx_status_.fill(0);
    tx_addr_.fill(0);
    for (auto& status : tx_status_)
        status = kTxHostOwns;
    curr_tx_desc_ = 0;
    rx_buf_ = 0;
    reset_rx_ring(8192);
    intr_status_ = 0;
    intr_mask_ = 0;
    multi_intr_ = 0;
    tx_config_ = 0x74800000u;  // HW_REVID(1,1,1,0,1,1,0)
    rx_config_ = 0;
    clock_enabled_ = true;
    chip_cmd_ = kCmdReset;
    config0_ = 0;
    config1_ = 0x0C;
    config3_ = 0x01;
    config4_ = 0;
    config5_ = 0;
    basic_mode_ctrl_ = 0x1000;
    basic_mode_status_ = 0x782Du;  // autoneg complete, link up
    nway_advert_ = 0x05E1;
    nway_lpar_ = 0x05E1;
    nway_expansion_ = 0x0001;
    cscr_ = 0x0340;  // force 100 Mbps, heartbeat, link down inactive
    rx_missed_ = 0;

    eeprom_.fill(0);
    eeprom_[0] = 0x8129;
    eeprom_[1] = 0x10EC;
    eeprom_[2] = 0x8139;
    eeprom_[7] = static_cast<std::uint16_t>(mac_[0] | (mac_[1] << 8));
    eeprom_[8] = static_cast<std::uint16_t>(mac_[2] | (mac_[3] << 8));
    eeprom_[9] = static_cast<std::uint16_t>(mac_[4] | (mac_[5] << 8));    eeprom_mode_ = EepromMode::None;
    eeprom_tick_ = 0;
    eeprom_address_ = 0;
    eeprom_input_ = eeprom_output_ = 0;
    eeprom_cs_ = eeprom_sk_ = eeprom_di_ = eeprom_do_ = 0;
    update_irq();
}

void Bba::reset_rx_ring(std::uint32_t size) {
    rx_buffer_size_ = size;
    rx_buf_ptr_ = 0;
    rx_buf_addr_ = 0;
}

// ---------------------------------------------------------------------------------------------
// MMIO dispatch

std::uint32_t Bba::read(std::uint32_t addr, unsigned size) {
    if (addr < kBase || addr >= kEnd)
        return 0xFFFFFFFFu;
    const std::uint32_t off = addr - kBase;
    if ((off & 0xFF0000u) == kSramOffset)
        return sram_read(off & 0xFFFFu, size);
    switch (off & 0xFFFF00u) {
        case kGapsBase:
        case kGapsBase + 0x100u: {
            const std::uint32_t reg = off & (kGapsSize - 1u);
            std::uint32_t value = 0;
            for (unsigned i = 0; i < size; ++i)
                reinterpret_cast<std::uint8_t*>(&value)[i] = gaps_[(reg + i) & (kGapsSize - 1u)];
            if (reg == kGapsReset)
                value &= 0xFFu;
            return value;
        }
        case kPciBase: {
            const std::uint32_t reg = off & (kPciSize - 1u);
            std::uint32_t value = 0;
            for (unsigned i = 0; i < size; ++i)
                reinterpret_cast<std::uint8_t*>(&value)[i] = pci_[(reg + i) & (kPciSize - 1u)];
            return value;
        }
        case kRtlBase:
            return rtl_read(off & (kRtlSize - 1u), size);
        default:
            return 0xFFFFFFFFu;
    }
}

void Bba::write(std::uint32_t addr, std::uint32_t value, unsigned size) {
    if (addr < kBase || addr >= kEnd)
        return;
    const std::uint32_t off = addr - kBase;
    if ((off & 0xFF0000u) == kSramOffset) {
        sram_write(off & 0xFFFFu, value, size);
        return;
    }
    switch (off & 0xFFFF00u) {
        case kGapsBase:
        case kGapsBase + 0x100u: {
            const std::uint32_t reg = off & (kGapsSize - 1u);
            for (unsigned i = 0; i < size; ++i)
                gaps_[(reg + i) & (kGapsSize - 1u)] = static_cast<std::uint8_t>(value >> (8 * i));
            if (config_.verbose)
                std::printf("bba: gaps write +0x%02x = 0x%x (size %u)\n", reg, value, size);
            if (reg == kGapsIntEnable) {
                set_interrupt();
            } else if (reg == kGapsReset) {
                if (value & 1u) {
                    std::printf("bba: bridge reset\n");
                    reset_rtl();
                    {
                        std::lock_guard<std::mutex> lock(reconnect_mutex_);
                        reconnect_ready_ = false;
                        online_host_.clear();
                        online_started_.store(false, std::memory_order_release);
                    }
                    reconnect_cv_.notify_all();
                    {
                        std::lock_guard<std::mutex> lock(net_control_mutex_);
                        net_.stop();
                    }
                }
            } else if (reg == kGapsDmaOffset) {
                dma_offset_ = value & (kSramSize - 1u);
            }
            break;
        }
        case kPciBase: {
            const std::uint32_t reg = off & (kPciSize - 1u);
            // Command, latency timer, the two BARs, the ROM window and the interrupt line are the
            // writable bytes a driver uses; status and identification stay read-only.
            const bool writable = (reg >= 0x04 && reg <= 0x05) || reg == 0x0D ||
                                  (reg >= 0x10 && reg <= 0x17) || (reg >= 0x30 && reg <= 0x33) ||
                                  reg == 0x3C;
            if (!writable)
                break;
            for (unsigned i = 0; i < size; ++i) {
                const std::uint32_t byte = reg + i;
                if (byte >= kPciSize)
                    break;
                pci_[byte] = static_cast<std::uint8_t>(value >> (8 * i));
            }
            if (size == 4 && reg == 0x10) {
                // BAR0 is an I/O window: the low bit is fixed and the size is 0x100.
                std::uint32_t bar = 0;
                std::memcpy(&bar, &pci_[0x10], 4);
                bar &= 0xFFFFFF01u;
                std::memcpy(&pci_[0x10], &bar, 4);
            } else if (size == 4 && reg == 0x14) {
                std::uint32_t bar = 0;
                std::memcpy(&bar, &pci_[0x14], 4);
                bar &= 0xFFFFFF00u;
                std::memcpy(&pci_[0x14], &bar, 4);
            }
            if (config_.verbose)
                std::printf("bba: pci write +0x%02x = 0x%x\n", reg, value);
            break;
        }
        case kRtlBase:
            rtl_write(off & (kRtlSize - 1u), value, size);
            break;
        default:
            break;
    }
}

std::uint32_t Bba::sram_read(std::uint32_t addr, unsigned size) {
    if (addr & 0x8000u)
        addr += dma_offset_;
    addr &= (kSramSize - 1u);
    std::uint32_t value = 0;
    for (unsigned i = 0; i < size; ++i)
        reinterpret_cast<std::uint8_t*>(&value)[i] = sram_[(addr + i) & (kSramSize - 1u)];
    return value;
}

void Bba::sram_write(std::uint32_t addr, std::uint32_t value, unsigned size) {
    if (addr & 0x8000u)
        addr += dma_offset_;
    addr &= (kSramSize - 1u);
    for (unsigned i = 0; i < size; ++i)
        sram_[(addr + i) & (kSramSize - 1u)] = static_cast<std::uint8_t>(value >> (8 * i));
}

void Bba::dma_read(std::uint32_t addr, std::uint8_t* out, std::size_t size) {
    for (std::size_t i = 0; i < size; ++i)
        out[i] = sram_[(addr + i) & (kSramSize - 1u)];
}

void Bba::dma_write(std::uint32_t addr, const std::uint8_t* in, std::size_t size) {
    for (std::size_t i = 0; i < size; ++i)
        sram_[(addr + i) & (kSramSize - 1u)] = in[i];
}

// ---------------------------------------------------------------------------------------------
// Interrupts

void Bba::update_irq() {
    interrupt_pending_ = (intr_status_ & intr_mask_) != 0;
    set_interrupt();
}

void Bba::set_interrupt() {
    std::uint32_t enable = 0;
    std::memcpy(&enable, gaps_.data() + kGapsIntEnable, 4);
    if (config_.verbose)
        std::printf("bba: set_interrupt pending=%d mask_gaps_enable=%u intr_status=0x%x intr_mask=0x%x\n",
                    interrupt_pending_ ? 1 : 0, enable, intr_status_, intr_mask_);
    if (interrupt_pending_ && enable != 0)
        intc_.raise(holly::Irq::ExtDevIrq);
    else
        intc_.clear(holly::Irq::ExtDevIrq);
}

// ---------------------------------------------------------------------------------------------
// RTL8139 registers

std::uint32_t Bba::rtl_read(std::uint32_t off, unsigned size) {
    switch (size) {
        case 1:
            return read8(off);
        case 2:
            return read16(off);
        case 4:
            return read32(off);
        default:
            return 0;
    }
}

void Bba::rtl_write(std::uint32_t off, std::uint32_t value, unsigned size) {
    if (config_.verbose)
        std::printf("bba: rtl mmio write +0x%04x = 0x%x (size %u)\n", off, value, size);
    switch (size) {
        case 1:
            write8(off, value);
            break;
        case 2:
            write16(off, value);
            break;
        case 4:
            write32(off, value);
            break;
        default:
            break;
    }
}

std::uint32_t Bba::read8(std::uint32_t off) {
    if (off < kMac0 + 6)
        return mac_[off - kMac0];
    if (off < kMac0 + 8)
        return 0;
    if (off >= kMar0 && off < kMar0 + 8)
        return mar_[off - kMar0];
    if (off >= kTxStatus0 && off < kTxStatus0 + 16)
        return (tx_status_[(off - kTxStatus0) / 4] >> ((off & 3u) * 8)) & 0xFFu;
    if (off >= kTxAddr0 && off < kTxAddr0 + 16)
        return (tx_addr_[(off - kTxAddr0) / 4] >> ((off & 3u) * 8)) & 0xFFu;
    if (off >= kRxBuf && off < kRxBuf + 4)
        return (rx_buf_ >> ((off & 3u) * 8)) & 0xFFu;
    switch (off) {
        case kRxBufPtr:
            return ((rx_buf_ptr_ - 0x10u) & 0xFFFFu) & 0xFFu;
        case kRxBufPtr + 1:
            return (((rx_buf_ptr_ - 0x10u) & 0xFFFFu) >> 8) & 0xFFu;
        case kChipCmd: {
            if (config_.verbose)
                std::printf("bba: rtl mmio read +0x0037 (ChipCmd) = 0x%x\n", chip_cmd_);
            std::uint32_t v = chip_cmd_;
            const std::uint32_t unread = mod2(rx_buffer_size_ + rx_buf_addr_ - rx_buf_ptr_, rx_buffer_size_);
            if (unread == 0)
                v |= 0x01u;  // RxBufEmpty
            return v;
        }
        case kIntrMask:
            return intr_mask_ & 0xFFu;
        case kIntrMask + 1:
            return (intr_mask_ >> 8) & 0xFFu;
        case kIntrStatus:
            return intr_status_ & 0xFFu;
        case kIntrStatus + 1:
            return (intr_status_ >> 8) & 0xFFu;
        case kTxConfig:
        case kTxConfig + 1:
        case kTxConfig + 2:
        case kTxConfig + 3:
            return (tx_config_ >> ((off - kTxConfig) * 8)) & 0xFFu;
        case kRxConfig:
        case kRxConfig + 1:
        case kRxConfig + 2:
        case kRxConfig + 3:
            return (rx_config_ >> ((off - kRxConfig) * 8)) & 0xFFu;
        case kCfg9346:
            return cfg9346_read();
        case kConfig0:
            return config0_;
        case kConfig1:
            return config1_;
        case kConfig3:
            return config3_;
        case kConfig4:
            return config4_;
        case kConfig5:
            return config5_;
        case kMediaStatus:
            return 0xD0u | (~basic_mode_status_ & 0x04u);
        case kHltClk:
            return clock_enabled_ ? 1u : 0u;
        case kPciRevisionId:
            return 0x10u;
        case kTxThresh:
            return 0xFFu;
        default:
            return 0;
    }
}

std::uint32_t Bba::read16(std::uint32_t off) {
    switch (off) {
        case kRxBufPtr:
            return (rx_buf_ptr_ - 0x10u) & 0xFFFFu;
        case kRxBufAddr:
            return rx_buf_addr_ & 0xFFFFu;
        case kIntrMask:
            if (config_.verbose)
                std::printf("bba: rtl mmio read +0x003c (IntrMask) = 0x%x\n", intr_mask_);
            return intr_mask_;
        case kIntrStatus:
            if (config_.verbose)
                std::printf("bba: rtl mmio read +0x003e (IntrStatus) = 0x%x\n", intr_status_);
            return intr_status_;
        case kMultiIntr:
            return multi_intr_;
        case kBasicModeCtrl:
            return basic_mode_ctrl_;
        case kBasicModeStatus:
            return basic_mode_status_;
        case kNWayAdvert:
            return nway_advert_;
        case kNWayLPAR:
            return nway_lpar_;
        case kNWayExpansion:
            return nway_expansion_;
        case kCSCR:
            return cscr_;
        case kTxSummary: {
            std::uint16_t summary = 0;
            for (unsigned i = 0; i < 4; ++i) {
                if (tx_status_[i] & kTxStatOk)
                    summary |= static_cast<std::uint16_t>(0x1000u << i);
                if (tx_status_[i] & kTxHostOwns)
                    summary |= static_cast<std::uint16_t>(1u << i);
            }
            return summary;
        }
        case kCpCmd:
            return 0xFFFFu;
        default:
            return read8(off) | (read8(off + 1) << 8);
    }
}

std::uint32_t Bba::read32(std::uint32_t off) {
    switch (off) {
        case kRxMissed:
            return rx_missed_;
        case kTxConfig:
            return tx_config_;
        case kRxConfig:
            return rx_config_;
        case kRxBuf:
            return rx_buf_;
        case kTimer:
            return 0;
        default:
            if (off >= kTxStatus0 && off < kTxStatus0 + 16)
                return tx_status_[(off - kTxStatus0) / 4];
            if (off >= kTxAddr0 && off < kTxAddr0 + 16)
                return tx_addr_[(off - kTxAddr0) / 4];
            return read16(off) | (read16(off + 2) << 16);
    }
}

void Bba::write8(std::uint32_t off, std::uint32_t value) {
    const std::uint32_t v = value & 0xFFu;
    if (off < kMac0 + 6) {
        mac_[off - kMac0] = static_cast<std::uint8_t>(v);
        return;
    }
    if (off >= kMar0 && off < kMar0 + 8) {
        mar_[off - kMar0] = static_cast<std::uint8_t>(v);
        return;
    }
    switch (off) {
        case kChipCmd:
            if (v & kCmdReset) {
                reset_rtl();
            }
            chip_cmd_ = static_cast<std::uint8_t>(set_masked(v, 0xE3u, chip_cmd_));
            chip_cmd_ &= static_cast<std::uint8_t>(~kCmdReset);
            if (config_.verbose)
                std::printf("bba: ChipCmd 0x%02x\n", chip_cmd_);
            break;
        case kCfg9346:
            cfg9346_write(v);
            break;
        case kTxConfig:
            tx_config_ = set_masked(v, 0xFCF0F80Fu, tx_config_);
            break;
        case kRxConfig:
            rx_config_ = set_masked(v, 0xF0FC0040u, rx_config_);
            break;
        case kConfig0:
            if ((cfg9346_ & 0xC0u) == 0xC0u)
                config0_ = static_cast<std::uint8_t>(set_masked(v, 0xF8u, config0_));
            break;
        case kConfig1:
            if ((cfg9346_ & 0xC0u) == 0xC0u)
                config1_ = static_cast<std::uint8_t>(set_masked(v, 0x0Cu, config1_));
            break;
        case kConfig3:
            if ((cfg9346_ & 0xC0u) == 0xC0u)
                config3_ = static_cast<std::uint8_t>(set_masked(v, 0x8Fu, config3_));
            break;
        case kConfig4:
            if ((cfg9346_ & 0xC0u) == 0xC0u)
                config4_ = static_cast<std::uint8_t>(set_masked(v, 0x0Au, config4_));
            break;
        case kConfig5:
            config5_ = static_cast<std::uint8_t>(set_masked(v, 0x80u, config5_));
            break;
        case kHltClk:
            if (v == 'R')
                clock_enabled_ = true;
            else if (v == 'H')
                clock_enabled_ = false;
            break;
        case kTxPoll:
            transmit();
            break;
        default:
            break;
    }
}

void Bba::write16(std::uint32_t off, std::uint32_t value) {
    const std::uint32_t v = value & 0xFFFFu;
    switch (off) {
        case kIntrMask:
            if (config_.verbose)
                std::printf("bba: rtl mmio write16 +0x003c (IntrMask) = 0x%x -> 0x%x\n", v, static_cast<std::uint16_t>(set_masked(v, 0x1E00u, intr_mask_)));
            intr_mask_ = static_cast<std::uint16_t>(set_masked(v, 0x1E00u, intr_mask_));
            update_irq();
            break;
        case kIntrStatus: {
            intr_status_ &= static_cast<std::uint16_t>(~v);  // write-1-to-clear
            update_irq();
            break;
        }
        case kMultiIntr:
            multi_intr_ = static_cast<std::uint16_t>(set_masked(v, 0xF000u, multi_intr_));
            break;
        case kRxBufPtr:
            rx_buf_ptr_ = mod2(v + 0x10u, rx_buffer_size_);
            break;
        case kBasicModeCtrl:
            basic_mode_ctrl_ = static_cast<std::uint16_t>(v);
            break;
        case kBasicModeStatus:
            basic_mode_status_ = static_cast<std::uint16_t>(v);
            break;
        case kNWayAdvert:
            nway_advert_ = static_cast<std::uint16_t>(v);
            break;
        case kNWayExpansion:
            nway_expansion_ = static_cast<std::uint16_t>(v);
            break;
        default:
            write8(off, v & 0xFFu);
            write8(off + 1, (v >> 8) & 0xFFu);
            break;
    }
}

void Bba::write32(std::uint32_t off, std::uint32_t value) {
    switch (off) {
        case kRxMissed:
            rx_missed_ = 0;
            break;
        case kTxConfig:
            tx_config_ = set_masked(value, 0xFCF0F80Fu, tx_config_);
            break;
        case kRxConfig:
            rx_config_ = set_masked(value, 0xF0FC0040u, rx_config_);
            reset_rx_ring(8192u << ((rx_config_ >> 11) & 0x3u));
            break;
        case kRxBuf:
            rx_buf_ = value;
            break;
        case kTimer:
            break;
        default:
            if (off >= kTxStatus0 && off < kTxStatus0 + 16) {
                const unsigned descriptor = (off - kTxStatus0) / 4;
                std::uint32_t status = value & ~0xFF00C000u;
                status = set_masked(status, 0x00C00000u, tx_status_[descriptor]);
                tx_status_[descriptor] = status;
                transmit();
            } else if (off >= kTxAddr0 && off < kTxAddr0 + 16) {
                tx_addr_[(off - kTxAddr0) / 4] = value;
            } else {
                write16(off, value & 0xFFFFu);
                write16(off + 2, value >> 16);
            }
            break;
    }
}

// ---------------------------------------------------------------------------------------------
// EEPROM 9346

void Bba::cfg9346_write(std::uint32_t value) {
    value &= 0xFFu;
    value = set_masked(value, 0x31u, cfg9346_);
    const std::uint32_t opmode = value & 0xC0u;
    const std::uint32_t wires = value & 0x0Fu;
    if (opmode == 0x80u) {
        prom_set_wire((wires & 0x08u) ? 1 : 0, (wires & 0x04u) ? 1 : 0, (wires & 0x02u) ? 1 : 0);
    } else if (opmode == 0x40u) {
        value = 0;
        reset_rtl();
    }
    cfg9346_ = static_cast<std::uint8_t>(value);
}

std::uint32_t Bba::cfg9346_read() {
    std::uint32_t value = cfg9346_;
    if ((value & 0xC0u) == 0x80u) {
        if (eeprom_cs_ && eeprom_do_)
            value |= 0x01u;
        else
            value &= ~0x01u;
    }
    return value;
}

void Bba::prom_set_wire(int cs, int sk, int di) {
    const int old_cs = eeprom_cs_;
    const int old_sk = eeprom_sk_;
    eeprom_cs_ = static_cast<std::uint8_t>(cs);
    eeprom_sk_ = static_cast<std::uint8_t>(sk);
    eeprom_di_ = static_cast<std::uint8_t>(di);
    if (!old_cs && cs) {
        eeprom_tick_ = 0;
        eeprom_input_ = 0;
        eeprom_output_ = 0;
        eeprom_mode_ = EepromMode::EnterCommand;
    }
    if (!cs)
        return;
    if (!old_sk && sk)
        prom_shift_clock();
}

void Bba::prom_shift_clock() {
    const int bit = eeprom_di_ ? 1 : 0;
    ++eeprom_tick_;
    switch (eeprom_mode_) {
        case EepromMode::EnterCommand:
            if (bit) {
                eeprom_mode_ = EepromMode::ReadCommand;
                eeprom_tick_ = 0;
                eeprom_input_ = 0;
            }
            break;
        case EepromMode::ReadCommand:
            eeprom_input_ = static_cast<std::uint16_t>((eeprom_input_ << 1) | (bit & 1));
            if (eeprom_tick_ == 8)
                prom_decode(static_cast<std::uint8_t>(eeprom_input_ & 0xFFu));
            break;
        case EepromMode::DataRead:
            eeprom_do_ = (eeprom_output_ & 0x8000u) ? 1 : 0;
            eeprom_output_ = static_cast<std::uint16_t>(eeprom_output_ << 1);
            if (eeprom_tick_ == 16) {
                eeprom_mode_ = EepromMode::EnterCommand;
                eeprom_input_ = 0;
                eeprom_tick_ = 0;
            }
            break;
        case EepromMode::DataWrite:
            eeprom_input_ = static_cast<std::uint16_t>((eeprom_input_ << 1) | (bit & 1));
            if (eeprom_tick_ == 16) {
                eeprom_[eeprom_address_ & kEepromAddrMask] = eeprom_input_;
                eeprom_mode_ = EepromMode::None;
                eeprom_tick_ = 0;
                eeprom_input_ = 0;
            }
            break;
        case EepromMode::DataWriteAll:
            eeprom_input_ = static_cast<std::uint16_t>((eeprom_input_ << 1) | (bit & 1));
            if (eeprom_tick_ == 16) {
                for (auto& word : eeprom_)
                    word = eeprom_input_;
                eeprom_mode_ = EepromMode::EnterCommand;
                eeprom_tick_ = 0;
                eeprom_input_ = 0;
            }
            break;
        case EepromMode::None:
        default:
            break;
    }
}

void Bba::prom_decode(std::uint8_t command) {
    switch (command & 0xC0u) {
        case 0x80u:  // read
            eeprom_address_ = static_cast<std::uint8_t>(command & kEepromAddrMask);
            eeprom_output_ = eeprom_[eeprom_address_];
            eeprom_do_ = 0;
            eeprom_tick_ = 0;
            eeprom_mode_ = EepromMode::DataRead;
            break;
        case 0x40u:  // write
            eeprom_address_ = static_cast<std::uint8_t>(command & kEepromAddrMask);
            eeprom_input_ = 0;
            eeprom_tick_ = 0;
            eeprom_mode_ = EepromMode::None;
            break;
        default:
            eeprom_mode_ = EepromMode::None;
            switch (command & 0xF0u) {
                case 0x10u:
                    eeprom_mode_ = EepromMode::DataWriteAll;
                    eeprom_input_ = 0;
                    eeprom_tick_ = 0;
                    break;
                default:
                    break;
            }
            break;
    }
}

// ---------------------------------------------------------------------------------------------
// Transmit and receive

void Bba::ensure_online() {
    if (online_started_.exchange(true, std::memory_order_acq_rel))
        return;
    std::string host = config_.server;
    if (config_.discover || host.empty()) {
        std::string error;
        std::string found = host;
        if (net::DcNetClient::discover(found, config_.port, error))
            host = found;
        else if (host.empty())
            host = "dcnet.flyca.st";
    }
    std::string error;
    bool connected = false;
    {
        std::lock_guard<std::mutex> lock(net_control_mutex_);
        connected = net_.start(host, config_.port, net::DcNetClient::Mode::Ethernet, error);
    }
    {
        std::lock_guard<std::mutex> lock(reconnect_mutex_);
        online_host_ = host;
        reconnect_ready_ = true;
    }
    reconnect_cv_.notify_all();
    if (connected) {
        std::printf("bba: online through DCNet at %s\n", net_.endpoint().c_str());
    } else {
        std::printf("bba: online unavailable (%s); automatic reconnect enabled\n", error.c_str());
    }
}

void Bba::reconnect_main() {
    std::unique_lock<std::mutex> state_lock(reconnect_mutex_);
    auto retry_delay = std::chrono::seconds(1);
    while (!reconnect_shutdown_) {
        reconnect_cv_.wait(state_lock, [this] {
            return reconnect_shutdown_ || reconnect_ready_;
        });
        if (reconnect_shutdown_)
            break;
        // Check a live connection once a second. Failed connections use exponential backoff,
        // capped at 30 seconds; the socket work is never done on the emulation thread.
        if (reconnect_cv_.wait_for(state_lock, retry_delay, [this] {
                return reconnect_shutdown_ || !reconnect_ready_;
            })) {
            retry_delay = std::chrono::seconds(1);
            continue;
        }
        if (reconnect_shutdown_ || !reconnect_ready_)
            continue;
        const std::string host = online_host_;
        state_lock.unlock();

        bool connected = false;
        std::string error;
        {
            std::lock_guard<std::mutex> net_lock(net_control_mutex_);
            if (online_started_.load(std::memory_order_acquire)) {
                if (net_.connected()) {
                    connected = true;
                } else {
                    // A failed reader/writer leaves joinable threads behind. stop() joins them
                    // before start() reuses the client.
                    net_.stop();
                    connected = net_.start(host, config_.port, net::DcNetClient::Mode::Ethernet, error);
                    if (connected)
                        std::printf("bba: reconnected through DCNet at %s\n",
                                    net_.endpoint().c_str());
                }
            }
        }

        state_lock.lock();
        if (reconnect_shutdown_)
            break;
        if (!reconnect_ready_ || !online_started_.load(std::memory_order_acquire)) {
            retry_delay = std::chrono::seconds(1);
            continue;
        }
        if (connected) {
            retry_delay = std::chrono::seconds(1);
        } else {
            std::fprintf(stderr, "bba: DCNet reconnect failed (%s); retrying in %lld s\n",
                         error.empty() ? "connection lost" : error.c_str(),
                         static_cast<long long>(retry_delay.count()));
            retry_delay = std::min(retry_delay * 2, std::chrono::seconds(30));
        }
    }
}

bool Bba::transmit_one(unsigned descriptor) {
    if (!transmitter_enabled())
        return false;
    if (tx_status_[descriptor] & kTxHostOwns)
        return false;
    const std::uint32_t size = tx_status_[descriptor] & 0x1FFFu;
    if (size == 0 || size > kMaxEthFrame) {
        tx_status_[descriptor] |= kTxHostOwns | kTxStatOk;
        return true;
    }
    std::vector<std::uint8_t> frame(size);
    dma_read(tx_addr_[descriptor], frame.data(), size);
    tx_status_[descriptor] |= kTxHostOwns | kTxStatOk;
    ++tx_frames;
    if (config_.verbose) {
        std::printf("bba: tx %u bytes (descriptor %u):", size, descriptor);
        for (std::size_t i = 0; i < frame.size() && i < 128; ++i)
            std::printf(" %02x", frame[i]);
        if (frame.size() > 128)
            std::printf(" ...");
        std::printf("\n");
    }

    constexpr std::uint32_t kTxLoopBack = (1u << 18) | (1u << 17);
    if ((tx_config_ & kTxLoopBack) == kTxLoopBack)
        receive(frame.data(), frame.size());
    else {
        ensure_online();
        net_.send_frame(frame.data(), frame.size());
    }

    intr_status_ |= kIntrTxOk;
    update_irq();
    return true;
}

void Bba::transmit() {
    if (transmit_one(curr_tx_desc_))
        curr_tx_desc_ = (curr_tx_desc_ + 1) & 3u;
}

bool Bba::can_receive() {
    if (!clock_enabled_)
        return true;
    if (!receiver_enabled())
        return true;
    const std::uint32_t avail = mod2(rx_buffer_size_ + rx_buf_ptr_ - rx_buf_addr_, rx_buffer_size_);
    return avail == 0 || avail >= 1514u || (intr_mask_ & kIntrRxOverflow) != 0;
}

void Bba::receive_write(const std::uint8_t* data, std::size_t size) {
    if (rx_buf_addr_ + size > rx_buffer_size_) {
        const std::uint32_t wrapped = mod2(rx_buf_addr_ + static_cast<std::uint32_t>(size), rx_buffer_size_);
        if (wrapped != 0 && !(rx_buffer_size_ < 65536u && (rx_config_ & (1u << 7)) != 0)) {
            if (size > static_cast<std::size_t>(wrapped))
                dma_write(rx_buf_ + rx_buf_addr_, data, size - wrapped);
            rx_buf_addr_ = 0;
            dma_write(rx_buf_, data + (size - wrapped), wrapped);
            rx_buf_addr_ = wrapped;
            return;
        }
    }
    dma_write(rx_buf_ + rx_buf_addr_, data, size);
    rx_buf_addr_ += static_cast<std::uint32_t>(size);
}

bool Bba::receive(const std::uint8_t* frame, std::size_t size) {
    if (!clock_enabled_ || !receiver_enabled())
        return false;
    if (config_.verbose)
        std::printf("bba: rx %zu bytes\n", size);

    std::uint32_t header = 0;
    static constexpr std::uint8_t kBroadcast[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    if ((rx_config_ & kAcceptAllPhys) != 0) {
        // promiscuous: accept everything
    } else if (std::memcmp(frame, kBroadcast, 6) == 0) {
        if ((rx_config_ & kAcceptBroadcast) == 0)
            return false;
        header |= kRxBroadcast;
    } else if ((frame[0] & 0x01u) != 0) {
        if ((rx_config_ & kAcceptMulticast) == 0)
            return false;
        const std::uint32_t index = crc32_ieee(frame, 6) >> 26;
        if ((mar_[(index >> 3) & 7u] & (1u << (index & 7u))) == 0)
            return false;
        header |= kRxMulticast;
    } else if (std::memcmp(frame, mac_.data(), 6) == 0) {
        if ((rx_config_ & kAcceptMyPhys) == 0)
            return false;
        header |= kRxPhysical;
    } else {
        return false;
    }

    std::vector<std::uint8_t> padded;
    const std::uint8_t* payload = frame;
    if (size < kMinEthFrame) {
        padded.assign(frame, frame + size);
        padded.resize(kMinEthFrame, 0);
        payload = padded.data();
        size = kMinEthFrame;
    }

    const std::uint32_t avail = mod2(rx_buffer_size_ + rx_buf_ptr_ - rx_buf_addr_, rx_buffer_size_);
    if (avail != 0 && rx_align(static_cast<std::uint32_t>(size) + 8) >= avail) {
        intr_status_ |= kIntrRxOverflow;
        ++rx_missed_;
        update_irq();
        return false;
    }

    header |= kRxStatusOk;
    header |= (static_cast<std::uint32_t>(size) + 4u) << 16;
    const std::uint32_t little = header;
    receive_write(reinterpret_cast<const std::uint8_t*>(&little), 4);
    receive_write(payload, size);
    const std::uint32_t crc = crc32_ieee(payload, size);
    receive_write(reinterpret_cast<const std::uint8_t*>(&crc), 4);
    rx_buf_addr_ = mod2(rx_align(rx_buf_addr_), rx_buffer_size_);

    intr_status_ |= kIntrRxOk;
    // Ensure the guest sees the RX interrupt: the title toggles IntrMask off between enabling
    // it and the frame arriving, so force-enable RxOK here. The guest can disable it again on
    // the next IntrMask write.
    intr_mask_ |= static_cast<std::uint16_t>(kIntrRxOk);
    update_irq();
    ++rx_frames;
    return true;
}

void Bba::poll_rx() {
    if (!rx_pending_.load(std::memory_order_acquire))
        return;
    std::lock_guard<std::mutex> lock(rx_mutex_);
    while (!rx_queue_.empty() && can_receive()) {
        const std::vector<std::uint8_t>& frame = rx_queue_.front();
        receive(frame.data(), frame.size());
        rx_queue_.pop_front();
    }
    rx_pending_.store(!rx_queue_.empty(), std::memory_order_release);
}

}  // namespace dream::hw
