// Bomberman Online: what this port tells dreamcomp.
// Game facts with sources live in docs/GAME-INTERNALS.md; evidence in docs/findings/.
#include "dreamcomp/hook.h"
#include "dreamcomp/port.h"

#include "dream/runtime/mem/dc_memory.h"
#include "dream/runtime/system.h"

namespace {

// Expansion-device registers that the guest probes but are not present in this
// configuration (no modem, no BBA). Reads return 0xFFFFFFFF ("device absent"),
// matching the probe's convention: a register value of 0xFFFFFFFF means no
// device answered. Writes are ignored. The five fault addresses observed at
// frame 24 of the first windowed run are:
//   0xA0600000 / 0xA0600004  Dreamcast modem id/enable and control registers
//   0xA1000400 / 0xA1000800  G2 expansion-device window (unnamed)
//   0xA1001400               BBA (HIT-0400) GAPS PCI bridge base
// The same probe routine appears in both FM_UTL.BIN and FM_UTL_PPPOE.BIN, so
// the device choice is not filename-selected; here we model all of them as
// absent. Real modem/BBA models can replace this handler later.
class AbsentDevice final : public dream::mem::MmioHandler {
public:
    std::uint32_t read(std::uint32_t, unsigned) override { return 0xFFFFFFFFu; }
    void write(std::uint32_t, std::uint32_t, unsigned) override {}
};

const dreamcomp::PortInfo kInfo = [] {
    dreamcomp::PortInfo p;
    p.id = "bomberman_online";
    p.title = "Bomberman Online";
    p.on_start = [](dream::System& sys, dreamcomp::Settings&) {
        static AbsentDevice absent;
        // Physical addresses (resolve() masks with 0x1FFFFFFF):
        //   0xA0600000-0xA06007FF -> 0x00600000-0x006007FF  Dreamcast modem window (id/enable + control regs)
        //   0xA1000400            -> 0x01000400              G2 expansion-device window
        //   0xA1000800            -> 0x01000800              G2 expansion-device window
        //   0xA1001400            -> 0x01001400              BBA (HIT-0400) GAPS PCI bridge base
        sys.memory.map_mmio(0x00600000u, 0x00600800u, &absent);
        sys.memory.map_mmio(0x01000400u, 0x01000404u, &absent);
        sys.memory.map_mmio(0x01000800u, 0x01000804u, &absent);
        sys.memory.map_mmio(0x01001400u, 0x01001404u, &absent);
    };
    return p;
}();
dreamcomp::RegisterPort g_register(kInfo);

}  // namespace
