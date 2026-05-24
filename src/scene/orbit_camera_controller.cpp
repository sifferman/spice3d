#include "orbit_camera_controller.h"

#include <cmath>

#include "godot_cpp/classes/global_constants.hpp"
#include "godot_cpp/classes/input_event_mouse_button.hpp"
#include "godot_cpp/classes/input_event_mouse_motion.hpp"
#include "godot_cpp/core/class_db.hpp"

namespace spice3d {

namespace {

constexpr double INITIAL_ORBIT_PIVOT_WORLD_X = 45.0;
constexpr double INITIAL_ORBIT_PIVOT_WORLD_Y = 0.0;
constexpr double INITIAL_ORBIT_PIVOT_WORLD_Z = 30.0;
constexpr double INITIAL_ORBIT_DISTANCE_FROM_PIVOT = 320.0;
constexpr double INITIAL_ORBIT_YAW_RADIANS = 0.0;
constexpr double INITIAL_ORBIT_PITCH_RADIANS = 1.45;

constexpr double ORBIT_RADIANS_PER_MOUSE_PIXEL = 0.006;
constexpr double MAXIMUM_ABSOLUTE_PITCH_RADIANS = 1.5;
constexpr double PIVOT_PAN_WORLD_UNITS_PER_MOUSE_PIXEL_PER_DISTANCE_UNIT = 0.0015;
constexpr double ORBIT_DISTANCE_MULTIPLIER_PER_SCROLL_NOTCH = 1.12;
constexpr double MINIMUM_ORBIT_DISTANCE_FROM_PIVOT = 30.0;
constexpr double MAXIMUM_ORBIT_DISTANCE_FROM_PIVOT = 4000.0;

double clamp_double_between(double value, double minimum, double maximum) {
	if (value < minimum) return minimum;
	if (value > maximum) return maximum;
	return value;
}

godot::Vector3 unit_offset_vector_for_orbit_angles(double yaw_radians, double pitch_radians) {
	const double pitch_cosine = std::cos(pitch_radians);
	return godot::Vector3(
			std::sin(yaw_radians) * pitch_cosine,
			std::sin(pitch_radians),
			std::cos(yaw_radians) * pitch_cosine);
}

} // namespace

void OrbitCameraController::_bind_methods() {}

OrbitCameraController::OrbitCameraController() :
		orbit_pivot_world_position(
				INITIAL_ORBIT_PIVOT_WORLD_X,
				INITIAL_ORBIT_PIVOT_WORLD_Y,
				INITIAL_ORBIT_PIVOT_WORLD_Z),
		orbit_distance_from_pivot(INITIAL_ORBIT_DISTANCE_FROM_PIVOT),
		orbit_yaw_radians(INITIAL_ORBIT_YAW_RADIANS),
		orbit_pitch_radians(INITIAL_ORBIT_PITCH_RADIANS) {}

void OrbitCameraController::_ready() {
	apply_orbit_state_to_camera_transform();
}

void OrbitCameraController::_unhandled_input(const godot::Ref<godot::InputEvent> &input_event) {
	const godot::Ref<godot::InputEventMouseButton> mouse_button_event = input_event;
	if (mouse_button_event.is_valid()) {
		const godot::MouseButton button_index = mouse_button_event->get_button_index();
		const bool button_is_pressed = mouse_button_event->is_pressed();
		if (button_index == godot::MOUSE_BUTTON_RIGHT) {
			is_currently_orbiting_via_right_drag = button_is_pressed;
		} else if (button_index == godot::MOUSE_BUTTON_MIDDLE) {
			is_currently_panning_via_middle_drag = button_is_pressed;
		} else if (button_index == godot::MOUSE_BUTTON_WHEEL_UP && button_is_pressed) {
			apply_mouse_scroll_to_orbit_distance(-1.0);
			apply_orbit_state_to_camera_transform();
		} else if (button_index == godot::MOUSE_BUTTON_WHEEL_DOWN && button_is_pressed) {
			apply_mouse_scroll_to_orbit_distance(1.0);
			apply_orbit_state_to_camera_transform();
		}
		return;
	}
	const godot::Ref<godot::InputEventMouseMotion> mouse_motion_event = input_event;
	if (mouse_motion_event.is_valid()) {
		const godot::Vector2 mouse_relative_motion = mouse_motion_event->get_relative();
		if (is_currently_orbiting_via_right_drag) {
			apply_mouse_drag_motion_to_orbit_state(mouse_relative_motion);
			apply_orbit_state_to_camera_transform();
		} else if (is_currently_panning_via_middle_drag) {
			apply_mouse_drag_motion_to_pivot_pan(mouse_relative_motion);
			apply_orbit_state_to_camera_transform();
		}
	}
}

void OrbitCameraController::apply_orbit_state_to_camera_transform() {
	const godot::Vector3 unit_offset_from_pivot =
			unit_offset_vector_for_orbit_angles(orbit_yaw_radians, orbit_pitch_radians);
	const godot::Vector3 new_camera_world_position =
			orbit_pivot_world_position + unit_offset_from_pivot * orbit_distance_from_pivot;
	const godot::Vector3 world_up_axis(0.0, 1.0, 0.0);
	look_at_from_position(new_camera_world_position, orbit_pivot_world_position, world_up_axis);
}

void OrbitCameraController::apply_mouse_drag_motion_to_orbit_state(const godot::Vector2 &mouse_relative_motion) {
	orbit_yaw_radians -= mouse_relative_motion.x * ORBIT_RADIANS_PER_MOUSE_PIXEL;
	orbit_pitch_radians += mouse_relative_motion.y * ORBIT_RADIANS_PER_MOUSE_PIXEL;
	orbit_pitch_radians = clamp_double_between(
			orbit_pitch_radians,
			-MAXIMUM_ABSOLUTE_PITCH_RADIANS,
			MAXIMUM_ABSOLUTE_PITCH_RADIANS);
}

void OrbitCameraController::apply_mouse_drag_motion_to_pivot_pan(const godot::Vector2 &mouse_relative_motion) {
	const godot::Transform3D current_camera_transform = get_global_transform();
	const godot::Vector3 camera_right_axis_in_world = current_camera_transform.basis.get_column(0);
	const godot::Vector3 camera_up_axis_in_world = current_camera_transform.basis.get_column(1);
	const double pan_scale_for_current_distance =
			PIVOT_PAN_WORLD_UNITS_PER_MOUSE_PIXEL_PER_DISTANCE_UNIT * orbit_distance_from_pivot;
	orbit_pivot_world_position -= camera_right_axis_in_world * mouse_relative_motion.x * pan_scale_for_current_distance;
	orbit_pivot_world_position += camera_up_axis_in_world * mouse_relative_motion.y * pan_scale_for_current_distance;
}

void OrbitCameraController::apply_mouse_scroll_to_orbit_distance(double scroll_direction_positive_for_zoom_out) {
	if (scroll_direction_positive_for_zoom_out > 0.0) {
		orbit_distance_from_pivot *= ORBIT_DISTANCE_MULTIPLIER_PER_SCROLL_NOTCH;
	} else {
		orbit_distance_from_pivot /= ORBIT_DISTANCE_MULTIPLIER_PER_SCROLL_NOTCH;
	}
	orbit_distance_from_pivot = clamp_double_between(
			orbit_distance_from_pivot,
			MINIMUM_ORBIT_DISTANCE_FROM_PIVOT,
			MAXIMUM_ORBIT_DISTANCE_FROM_PIVOT);
}

} // namespace spice3d
