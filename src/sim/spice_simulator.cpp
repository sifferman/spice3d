#include "spice_simulator.h"

#ifdef WEB_ENABLED
#include "web/spice_simulator_web.h"
#else
#include "native/spice_simulator_native.h"
#endif

namespace spice3d {

std::unique_ptr<SpiceSimulator> SpiceSimulator::create() {
#ifdef WEB_ENABLED
	return std::make_unique<web::SpiceSimulatorWeb>();
#else
	return std::make_unique<native::SpiceSimulatorNative>();
#endif
}

} // namespace spice3d
