#include "register_types.h"

#include <gdextension_interface.h>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>

#include "spice3d_node.h"

void initialize_spice3d_module(godot::ModuleInitializationLevel module_initialization_level) {
	if (module_initialization_level != godot::MODULE_INITIALIZATION_LEVEL_SCENE) {
		return;
	}
	GDREGISTER_CLASS(spice3d::Spice3DNode);
}

void uninitialize_spice3d_module(godot::ModuleInitializationLevel module_initialization_level) {
	if (module_initialization_level != godot::MODULE_INITIALIZATION_LEVEL_SCENE) {
		return;
	}
}

extern "C" {

GDExtensionBool GDE_EXPORT spice3d_library_init(
		GDExtensionInterfaceGetProcAddress get_proc_address,
		GDExtensionClassLibraryPtr library_pointer,
		GDExtensionInitialization *initialization_out) {
	godot::GDExtensionBinding::InitObject init_object(
			get_proc_address,
			library_pointer,
			initialization_out);
	init_object.register_initializer(initialize_spice3d_module);
	init_object.register_terminator(uninitialize_spice3d_module);
	init_object.set_minimum_library_initialization_level(godot::MODULE_INITIALIZATION_LEVEL_SCENE);
	return init_object.init();
}

} // extern "C"
