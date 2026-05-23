#pragma once

#include "godot_cpp/classes/camera3d.hpp"
#include "godot_cpp/classes/input_event.hpp"
#include "godot_cpp/variant/vector2.hpp"
#include "godot_cpp/variant/vector3.hpp"

namespace spice3d {

class OrbitCameraController : public godot::Camera3D {
	GDCLASS(OrbitCameraController, godot::Camera3D)

protected:
	static void _bind_methods();

public:
	OrbitCameraController();
	~OrbitCameraController() override = default;

	void _ready() override;
	void _unhandled_input(const godot::Ref<godot::InputEvent> &input_event) override;

private:
	godot::Vector3 orbit_pivot_world_position;
	double orbit_distance_from_pivot = 0.0;
	double orbit_yaw_radians = 0.0;
	double orbit_pitch_radians = 0.0;
	bool is_currently_orbiting_via_right_drag = false;
	bool is_currently_panning_via_middle_drag = false;

	void apply_orbit_state_to_camera_transform();
	void apply_mouse_drag_motion_to_orbit_state(const godot::Vector2 &mouse_relative_motion);
	void apply_mouse_drag_motion_to_pivot_pan(const godot::Vector2 &mouse_relative_motion);
	void apply_mouse_scroll_to_orbit_distance(double scroll_direction_positive_for_zoom_out);
};

} // namespace spice3d
