#include "scene/schematic_renderer.h"

#include "godot_cpp/classes/area3d.hpp"
#include "godot_cpp/classes/array_mesh.hpp"
#include "godot_cpp/classes/box_mesh.hpp"
#include "godot_cpp/classes/box_shape3d.hpp"
#include "godot_cpp/classes/capsule_mesh.hpp"
#include "godot_cpp/classes/collision_shape3d.hpp"
#include "godot_cpp/classes/cylinder_mesh.hpp"
#include "godot_cpp/classes/geometry2d.hpp"
#include "godot_cpp/classes/label3d.hpp"
#include "godot_cpp/classes/mesh.hpp"
#include "godot_cpp/classes/mesh_instance3d.hpp"
#include "godot_cpp/classes/standard_material3d.hpp"
#include "godot_cpp/variant/array.hpp"
#include "godot_cpp/variant/basis.hpp"
#include "godot_cpp/variant/callable.hpp"
#include "godot_cpp/variant/color.hpp"
#include "godot_cpp/variant/packed_int32_array.hpp"
#include "godot_cpp/variant/packed_vector2_array.hpp"
#include "godot_cpp/variant/packed_vector3_array.hpp"
#include "godot_cpp/variant/transform3d.hpp"
#include "godot_cpp/variant/vector3.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>
#include <variant>

extern "C" {
#include "parser.h"
}

#include "scene/schematic_loader.h"
#include "spice3d_node.h"

namespace spice3d {

namespace {

godot::String c_string_to_godot_string(const std::string &source_text) {
	return godot::String(source_text.c_str());
}

constexpr double WIRE_STROKE_RADIUS_IN_WORLD_UNITS = 2.0;
constexpr double DRAWING_OUTLINE_STROKE_RADIUS_IN_WORLD_UNITS = 1.0;
constexpr double COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS = 60.0;
constexpr double ARC_TESSELLATION_DEGREES_PER_CYLINDER_SEGMENT = 6.0;
constexpr double TEXT_PIXEL_SIZE_PER_XSCHEM_VERTICAL_SIZE_FACTOR = 0.6;
constexpr double FILLED_DRAWING_EXTRUSION_HEIGHT_IN_WORLD_UNITS = 4.0;

const char *WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME = "spice_node_name";
const char *WIRE_MESH_INSTANCE_META_KEY_FOR_BUS_BIT_NET_NAMES_MSB_FIRST = "bus_bit_net_names_msb_first";

const std::string SYMBOL_TYPE_NAME_FOR_BUTTON_COMPONENTS = "vsource";
constexpr double BUTTON_AREA_COLLISION_SHAPE_VERTICAL_EXTENT_IN_WORLD_UNITS = 8.0;
constexpr double BUTTON_AREA_COLLISION_SHAPE_HORIZONTAL_MARGIN_IN_WORLD_UNITS = 5.0;

godot::Vector3 schematic_xy_to_lying_flat_world_position(double schematic_x, double schematic_y) {
	constexpr double table_surface_world_y = 0.0;
	return godot::Vector3(schematic_x, table_surface_world_y, schematic_y);
}

void transform_symbol_local_point_to_schematic_global_point(
		const ComponentInstance &component,
		double symbol_local_x,
		double symbol_local_y,
		double *out_schematic_global_x,
		double *out_schematic_global_y) {
	double rotated_local_x = 0.0;
	double rotated_local_y = 0.0;
	xs_transform_pin_to_global(
			component.rotation_quarter_turns,
			component.flip_flag,
			symbol_local_x,
			symbol_local_y,
			&rotated_local_x,
			&rotated_local_y);
	*out_schematic_global_x = component.placement_x + rotated_local_x;
	*out_schematic_global_y = component.placement_y + rotated_local_y;
}

godot::Ref<godot::StandardMaterial3D> build_component_placeholder_material() {
	godot::Ref<godot::StandardMaterial3D> placeholder_material;
	placeholder_material.instantiate();
	placeholder_material->set_albedo(godot::Color(0.85f, 0.55f, 0.25f));
	placeholder_material->set_metallic(0.2f);
	placeholder_material->set_roughness(0.55f);
	return placeholder_material;
}

godot::Ref<godot::StandardMaterial3D> build_drawing_outline_material() {
	godot::Ref<godot::StandardMaterial3D> outline_material;
	outline_material.instantiate();
	outline_material->set_albedo(godot::Color(0.95f, 0.85f, 0.4f));
	outline_material->set_metallic(0.1f);
	outline_material->set_roughness(0.45f);
	return outline_material;
}

godot::Basis basis_aligning_local_y_axis_with_xz_plane_direction(
		const godot::Vector3 &target_direction_in_xz_plane) {
	const double length_in_xz_plane = std::sqrt(
			target_direction_in_xz_plane.x * target_direction_in_xz_plane.x
					+ target_direction_in_xz_plane.z * target_direction_in_xz_plane.z);
	if (length_in_xz_plane <= 0.0) return godot::Basis();
	const double normalized_dx = target_direction_in_xz_plane.x / length_in_xz_plane;
	const double normalized_dz = target_direction_in_xz_plane.z / length_in_xz_plane;
	godot::Basis basis;
	basis.set_column(0, godot::Vector3(-normalized_dz, 0.0, normalized_dx));
	basis.set_column(1, godot::Vector3(normalized_dx, 0.0, normalized_dz));
	basis.set_column(2, godot::Vector3(0.0, 1.0, 0.0));
	return basis;
}

godot::Ref<godot::CapsuleMesh> build_capsule_mesh_with_radius_and_total_height(
		double capsule_radius, double total_height) {
	godot::Ref<godot::CapsuleMesh> capsule_mesh;
	capsule_mesh.instantiate();
	capsule_mesh->set_radius(capsule_radius);
	capsule_mesh->set_height(std::max(total_height, 2.0 * capsule_radius));
	return capsule_mesh;
}

void add_capsule_segment_between_two_schematic_points(
		godot::Node3D *parent_node,
		double start_schematic_x, double start_schematic_y,
		double end_schematic_x, double end_schematic_y,
		double capsule_stroke_radius,
		const godot::Ref<godot::Material> &capsule_material) {
	const godot::Vector3 start_world_point = schematic_xy_to_lying_flat_world_position(start_schematic_x, start_schematic_y);
	const godot::Vector3 end_world_point = schematic_xy_to_lying_flat_world_position(end_schematic_x, end_schematic_y);
	const godot::Vector3 segment_direction_in_world = end_world_point - start_world_point;
	const double segment_length_in_world = segment_direction_in_world.length();
	if (segment_length_in_world <= 0.0) return;

	const double capsule_total_height_with_extended_caps =
			segment_length_in_world + 2.0 * capsule_stroke_radius;

	godot::MeshInstance3D *capsule_mesh_instance = memnew(godot::MeshInstance3D);
	capsule_mesh_instance->set_mesh(build_capsule_mesh_with_radius_and_total_height(
			capsule_stroke_radius, capsule_total_height_with_extended_caps));
	capsule_mesh_instance->set_material_override(capsule_material);

	godot::Transform3D capsule_transform;
	capsule_transform.basis = basis_aligning_local_y_axis_with_xz_plane_direction(segment_direction_in_world);
	capsule_transform.origin = (start_world_point + end_world_point) * 0.5;
	capsule_mesh_instance->set_transform(capsule_transform);
	parent_node->add_child(capsule_mesh_instance);
}

godot::Ref<godot::CylinderMesh> build_cylinder_mesh_with_radius_and_total_height(
		double cylinder_radius, double total_height) {
	godot::Ref<godot::CylinderMesh> cylinder_mesh;
	cylinder_mesh.instantiate();
	cylinder_mesh->set_top_radius(cylinder_radius);
	cylinder_mesh->set_bottom_radius(cylinder_radius);
	cylinder_mesh->set_height(total_height);
	return cylinder_mesh;
}

void add_cylinder_segment_between_two_schematic_points(
		godot::Node3D *parent_node,
		double start_schematic_x, double start_schematic_y,
		double end_schematic_x, double end_schematic_y,
		double cylinder_stroke_radius,
		const godot::Ref<godot::Material> &cylinder_material) {
	const godot::Vector3 start_world_point = schematic_xy_to_lying_flat_world_position(start_schematic_x, start_schematic_y);
	const godot::Vector3 end_world_point = schematic_xy_to_lying_flat_world_position(end_schematic_x, end_schematic_y);
	const godot::Vector3 segment_direction_in_world = end_world_point - start_world_point;
	const double segment_length_in_world = segment_direction_in_world.length();
	if (segment_length_in_world <= 0.0) return;

	godot::MeshInstance3D *cylinder_mesh_instance = memnew(godot::MeshInstance3D);
	cylinder_mesh_instance->set_mesh(build_cylinder_mesh_with_radius_and_total_height(
			cylinder_stroke_radius, segment_length_in_world));
	cylinder_mesh_instance->set_material_override(cylinder_material);

	godot::Transform3D cylinder_transform;
	cylinder_transform.basis = basis_aligning_local_y_axis_with_xz_plane_direction(segment_direction_in_world);
	cylinder_transform.origin = (start_world_point + end_world_point) * 0.5;
	cylinder_mesh_instance->set_transform(cylinder_transform);
	parent_node->add_child(cylinder_mesh_instance);
}

godot::String build_spice_node_name_from_xschem_net_label(const std::string &xschem_net_label) {
	std::string normalized = xschem_net_label;
	if (!normalized.empty() && normalized[0] == '#') {
		normalized = normalized.substr(1);
	}
	std::transform(normalized.begin(), normalized.end(), normalized.begin(),
			[](unsigned char one_character) {
				return static_cast<char>(std::tolower(one_character));
			});
	return c_string_to_godot_string(normalized);
}

godot::PackedStringArray expand_xschem_bus_label_to_scalar_net_names_msb_first(
		const std::string &bus_label) {
	godot::PackedStringArray scalar_net_names_msb_first;
	const auto left_bracket_position = bus_label.find('[');
	if (left_bracket_position == std::string::npos) return scalar_net_names_msb_first;
	const auto right_bracket_position = bus_label.find(']', left_bracket_position + 1);
	if (right_bracket_position == std::string::npos
			|| right_bracket_position <= left_bracket_position + 1) {
		return scalar_net_names_msb_first;
	}
	const std::string range_inside_brackets = bus_label.substr(
			left_bracket_position + 1,
			right_bracket_position - left_bracket_position - 1);
	const std::string bus_base_name = bus_label.substr(0, left_bracket_position);
	int high_bit_index = 0;
	int low_bit_index = 0;
	bool brackets_kept_in_scalar_form = false;
	if (std::sscanf(range_inside_brackets.c_str(), "%d:%d",
			&high_bit_index, &low_bit_index) == 2) {
		brackets_kept_in_scalar_form = true;
	} else if (std::sscanf(range_inside_brackets.c_str(), "%d..%d",
			&high_bit_index, &low_bit_index) == 2) {
		brackets_kept_in_scalar_form = false;
	} else {
		return scalar_net_names_msb_first;
	}
	const int step_from_high_to_low = (high_bit_index >= low_bit_index) ? -1 : 1;
	int current_bit_index = high_bit_index;
	while (true) {
		char one_scalar_buffer[256];
		if (brackets_kept_in_scalar_form) {
			std::snprintf(one_scalar_buffer, sizeof one_scalar_buffer,
					"%s[%d]", bus_base_name.c_str(), current_bit_index);
		} else {
			std::snprintf(one_scalar_buffer, sizeof one_scalar_buffer,
					"%s%d", bus_base_name.c_str(), current_bit_index);
		}
		std::string lowercased_scalar_net_name(one_scalar_buffer);
		std::transform(lowercased_scalar_net_name.begin(), lowercased_scalar_net_name.end(),
				lowercased_scalar_net_name.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		scalar_net_names_msb_first.append(godot::String(lowercased_scalar_net_name.c_str()));
		if (current_bit_index == low_bit_index) break;
		current_bit_index += step_from_high_to_low;
	}
	return scalar_net_names_msb_first;
}

godot::Ref<godot::StandardMaterial3D> build_wire_render_material_with_independent_albedo() {
	godot::Ref<godot::StandardMaterial3D> material;
	material.instantiate();
	material->set_albedo(godot::Color(0.55f, 0.6f, 0.75f));
	material->set_feature(godot::BaseMaterial3D::FEATURE_EMISSION, true);
	material->set_emission(godot::Color(0.15f, 0.2f, 0.4f));
	return material;
}

void add_wire_segment_capsule_to_parent_node(
		godot::Node3D *parent_node,
		const WireSegment &wire) {
	const godot::Vector3 start_world_point = schematic_xy_to_lying_flat_world_position(wire.start_x, wire.start_y);
	const godot::Vector3 end_world_point = schematic_xy_to_lying_flat_world_position(wire.end_x, wire.end_y);
	const godot::Vector3 segment_direction_in_world = end_world_point - start_world_point;
	const double segment_length_in_world = segment_direction_in_world.length();
	if (segment_length_in_world <= 0.0) return;

	const double capsule_total_height_with_extended_caps =
			segment_length_in_world + 2.0 * WIRE_STROKE_RADIUS_IN_WORLD_UNITS;

	const godot::Ref<godot::StandardMaterial3D> per_wire_material =
			build_wire_render_material_with_independent_albedo();

	godot::MeshInstance3D *wire_mesh_instance = memnew(godot::MeshInstance3D);
	wire_mesh_instance->set_mesh(build_capsule_mesh_with_radius_and_total_height(
			WIRE_STROKE_RADIUS_IN_WORLD_UNITS, capsule_total_height_with_extended_caps));
	wire_mesh_instance->set_material_override(per_wire_material);

	godot::Transform3D wire_transform;
	wire_transform.basis = basis_aligning_local_y_axis_with_xz_plane_direction(segment_direction_in_world);
	wire_transform.origin = (start_world_point + end_world_point) * 0.5;
	wire_mesh_instance->set_transform(wire_transform);
	if (wire.is_bus) {
		const godot::PackedStringArray bit_net_names_msb_first =
				expand_xschem_bus_label_to_scalar_net_names_msb_first(wire.net_label);
		wire_mesh_instance->set_meta(
				WIRE_MESH_INSTANCE_META_KEY_FOR_BUS_BIT_NET_NAMES_MSB_FIRST,
				bit_net_names_msb_first);
	} else {
		wire_mesh_instance->set_meta(
				WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME,
				build_spice_node_name_from_xschem_net_label(wire.net_label));
	}
	parent_node->add_child(wire_mesh_instance);
}

void add_component_placeholder_mesh_to_parent_node(
		godot::Node3D *parent_node,
		const ComponentInstance &component,
		const godot::Ref<godot::Material> &placeholder_material) {
	godot::Ref<godot::BoxMesh> placeholder_box_mesh;
	placeholder_box_mesh.instantiate();
	placeholder_box_mesh->set_size(
			godot::Vector3(COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS,
					COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS,
					COMPONENT_PLACEHOLDER_SIZE_IN_WORLD_UNITS));

	godot::MeshInstance3D *placeholder_mesh_instance = memnew(godot::MeshInstance3D);
	placeholder_mesh_instance->set_mesh(placeholder_box_mesh);
	placeholder_mesh_instance->set_material_override(placeholder_material);
	placeholder_mesh_instance->set_position(
			schematic_xy_to_lying_flat_world_position(component.placement_x, component.placement_y));
	parent_node->add_child(placeholder_mesh_instance);
}

void add_drawing_line_segment_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingLineSegment &line_segment,
		const godot::Ref<godot::Material> &outline_material) {
	add_capsule_segment_between_two_schematic_points(
			parent_node,
			line_segment.x1, line_segment.y1,
			line_segment.x2, line_segment.y2,
			DRAWING_OUTLINE_STROKE_RADIUS_IN_WORLD_UNITS,
			outline_material);
}

void add_drawing_box_outline_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingBox &box,
		const godot::Ref<godot::Material> &outline_material) {
	const double corners_x[4] = { box.x1, box.x2, box.x2, box.x1 };
	const double corners_y[4] = { box.y1, box.y1, box.y2, box.y2 };
	for (int corner_index = 0; corner_index < 4; ++corner_index) {
		const int next_corner_index = (corner_index + 1) % 4;
		add_capsule_segment_between_two_schematic_points(
				parent_node,
				corners_x[corner_index], corners_y[corner_index],
				corners_x[next_corner_index], corners_y[next_corner_index],
				DRAWING_OUTLINE_STROKE_RADIUS_IN_WORLD_UNITS,
				outline_material);
	}
}

void add_drawing_box_extruded_filled_mesh_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingBox &box,
		const godot::Ref<godot::Material> &fill_material) {
	const double box_width = std::abs(box.x2 - box.x1);
	const double box_depth = std::abs(box.y2 - box.y1);
	if (box_width <= 0.0 || box_depth <= 0.0) return;
	const double box_center_schematic_x = (box.x1 + box.x2) * 0.5;
	const double box_center_schematic_y = (box.y1 + box.y2) * 0.5;

	godot::Ref<godot::BoxMesh> filled_box_mesh;
	filled_box_mesh.instantiate();
	filled_box_mesh->set_size(godot::Vector3(
			box_width, FILLED_DRAWING_EXTRUSION_HEIGHT_IN_WORLD_UNITS, box_depth));

	godot::MeshInstance3D *filled_box_mesh_instance = memnew(godot::MeshInstance3D);
	filled_box_mesh_instance->set_mesh(filled_box_mesh);
	filled_box_mesh_instance->set_material_override(fill_material);
	godot::Vector3 box_center_world = schematic_xy_to_lying_flat_world_position(
			box_center_schematic_x, box_center_schematic_y);
	box_center_world.y = FILLED_DRAWING_EXTRUSION_HEIGHT_IN_WORLD_UNITS * 0.5;
	filled_box_mesh_instance->set_position(box_center_world);
	parent_node->add_child(filled_box_mesh_instance);
}

void add_drawing_box_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingBox &box,
		const godot::Ref<godot::Material> &outline_material,
		const godot::Ref<godot::Material> &fill_material) {
	if (box.filled) {
		add_drawing_box_extruded_filled_mesh_in_global_coordinates(parent_node, box, fill_material);
	} else {
		add_drawing_box_outline_in_global_coordinates(parent_node, box, outline_material);
	}
}

void add_drawing_polygon_outline_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingPolygon &polygon,
		const godot::Ref<godot::Material> &outline_material) {
	const size_t vertex_count = std::min(polygon.vertex_xs.size(), polygon.vertex_ys.size());
	if (vertex_count < 2) return;
	for (size_t edge_end_index = 1; edge_end_index < vertex_count; ++edge_end_index) {
		add_capsule_segment_between_two_schematic_points(
				parent_node,
				polygon.vertex_xs[edge_end_index - 1], polygon.vertex_ys[edge_end_index - 1],
				polygon.vertex_xs[edge_end_index],     polygon.vertex_ys[edge_end_index],
				DRAWING_OUTLINE_STROKE_RADIUS_IN_WORLD_UNITS,
				outline_material);
	}
}

size_t polygon_vertex_count_with_repeated_closing_vertex_stripped(const DrawingPolygon &polygon) {
	const size_t paired_count = std::min(polygon.vertex_xs.size(), polygon.vertex_ys.size());
	if (paired_count >= 2
			&& polygon.vertex_xs[0] == polygon.vertex_xs[paired_count - 1]
			&& polygon.vertex_ys[0] == polygon.vertex_ys[paired_count - 1]) {
		return paired_count - 1;
	}
	return paired_count;
}

void add_drawing_polygon_extruded_filled_mesh_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingPolygon &polygon,
		const godot::Ref<godot::Material> &fill_material) {
	const int unique_vertex_count = static_cast<int>(
			polygon_vertex_count_with_repeated_closing_vertex_stripped(polygon));
	if (unique_vertex_count < 3) return;

	godot::PackedVector2Array vertices_for_triangulation;
	vertices_for_triangulation.resize(unique_vertex_count);
	for (int i = 0; i < unique_vertex_count; ++i) {
		vertices_for_triangulation[i] =
				godot::Vector2(polygon.vertex_xs[i], polygon.vertex_ys[i]);
	}
	const godot::PackedInt32Array top_face_triangle_indices =
			godot::Geometry2D::get_singleton()->triangulate_polygon(vertices_for_triangulation);
	if (top_face_triangle_indices.is_empty()) return;

	godot::PackedVector3Array extruded_vertices;
	extruded_vertices.resize(2 * unique_vertex_count);
	for (int i = 0; i < unique_vertex_count; ++i) {
		const godot::Vector3 flat_position = schematic_xy_to_lying_flat_world_position(
				polygon.vertex_xs[i], polygon.vertex_ys[i]);
		extruded_vertices[i] = godot::Vector3(
				flat_position.x, FILLED_DRAWING_EXTRUSION_HEIGHT_IN_WORLD_UNITS, flat_position.z);
		extruded_vertices[unique_vertex_count + i] = flat_position;
	}

	godot::PackedInt32Array combined_triangle_indices;
	const int top_index_count = top_face_triangle_indices.size();
	for (int i = 0; i < top_index_count; ++i) {
		combined_triangle_indices.push_back(top_face_triangle_indices[i]);
	}
	for (int i = 0; i < top_index_count; i += 3) {
		combined_triangle_indices.push_back(unique_vertex_count + top_face_triangle_indices[i + 0]);
		combined_triangle_indices.push_back(unique_vertex_count + top_face_triangle_indices[i + 2]);
		combined_triangle_indices.push_back(unique_vertex_count + top_face_triangle_indices[i + 1]);
	}
	for (int i = 0; i < unique_vertex_count; ++i) {
		const int top_a = i;
		const int top_b = (i + 1) % unique_vertex_count;
		const int bottom_a = unique_vertex_count + top_a;
		const int bottom_b = unique_vertex_count + top_b;
		combined_triangle_indices.push_back(top_a);
		combined_triangle_indices.push_back(top_b);
		combined_triangle_indices.push_back(bottom_b);
		combined_triangle_indices.push_back(top_a);
		combined_triangle_indices.push_back(bottom_b);
		combined_triangle_indices.push_back(bottom_a);
	}

	godot::Array surface_arrays;
	surface_arrays.resize(godot::Mesh::ARRAY_MAX);
	surface_arrays[godot::Mesh::ARRAY_VERTEX] = extruded_vertices;
	surface_arrays[godot::Mesh::ARRAY_INDEX] = combined_triangle_indices;

	godot::Ref<godot::ArrayMesh> extruded_polygon_mesh;
	extruded_polygon_mesh.instantiate();
	extruded_polygon_mesh->add_surface_from_arrays(godot::Mesh::PRIMITIVE_TRIANGLES, surface_arrays);

	godot::MeshInstance3D *extruded_mesh_instance = memnew(godot::MeshInstance3D);
	extruded_mesh_instance->set_mesh(extruded_polygon_mesh);
	extruded_mesh_instance->set_material_override(fill_material);
	parent_node->add_child(extruded_mesh_instance);
}

void add_drawing_polygon_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingPolygon &polygon,
		const godot::Ref<godot::Material> &outline_material,
		const godot::Ref<godot::Material> &fill_material) {
	if (polygon.filled) {
		add_drawing_polygon_extruded_filled_mesh_in_global_coordinates(parent_node, polygon, fill_material);
	}
	add_drawing_polygon_outline_in_global_coordinates(parent_node, polygon, outline_material);
}

void add_drawing_arc_tessellated_cylinders_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingArc &arc,
		const godot::Ref<godot::Material> &outline_material) {
	if (arc.radius <= 0.0 || arc.sweep_angle_degrees == 0.0) return;
	const int tessellation_segment_count = std::max(3,
			static_cast<int>(std::ceil(
					std::abs(arc.sweep_angle_degrees) / ARC_TESSELLATION_DEGREES_PER_CYLINDER_SEGMENT)));
	const double start_angle_radians = arc.start_angle_degrees * Math_PI / 180.0;
	const double sweep_angle_radians = arc.sweep_angle_degrees * Math_PI / 180.0;
	double previous_x = arc.center_x + arc.radius * std::cos(start_angle_radians);
	double previous_y = arc.center_y - arc.radius * std::sin(start_angle_radians);
	for (int segment_index = 1; segment_index <= tessellation_segment_count; ++segment_index) {
		const double t = static_cast<double>(segment_index) / tessellation_segment_count;
		const double angle_radians = start_angle_radians + sweep_angle_radians * t;
		const double current_x = arc.center_x + arc.radius * std::cos(angle_radians);
		const double current_y = arc.center_y - arc.radius * std::sin(angle_radians);
		add_cylinder_segment_between_two_schematic_points(parent_node,
				previous_x, previous_y, current_x, current_y,
				DRAWING_OUTLINE_STROKE_RADIUS_IN_WORLD_UNITS,
				outline_material);
		previous_x = current_x;
		previous_y = current_y;
	}
}

void add_drawing_text_label_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingText &text_label,
		const godot::Color &text_color) {
	if (text_label.text.empty()) return;
	godot::Label3D *label_3d = memnew(godot::Label3D);
	label_3d->set_text(c_string_to_godot_string(text_label.text));
	label_3d->set_modulate(text_color);
	label_3d->set_billboard_mode(godot::BaseMaterial3D::BILLBOARD_ENABLED);
	label_3d->set_draw_flag(godot::Label3D::FLAG_DISABLE_DEPTH_TEST, true);
	label_3d->set_alpha_cut_mode(godot::Label3D::ALPHA_CUT_DISCARD);
	label_3d->set_pixel_size(
			text_label.vertical_size_factor * TEXT_PIXEL_SIZE_PER_XSCHEM_VERTICAL_SIZE_FACTOR);
	label_3d->set_position(schematic_xy_to_lying_flat_world_position(
			text_label.anchor_x, text_label.anchor_y));
	parent_node->add_child(label_3d);
}

struct DrawingRenderMaterials {
	godot::Ref<godot::Material> outline;
	godot::Ref<godot::Material> fill;
	godot::Color text_color;
};

bool component_symbol_type_matches_button_vsource(const ComponentInstance &component) {
	return component.symbol_was_resolved
			&& component.symbol_type == SYMBOL_TYPE_NAME_FOR_BUTTON_COMPONENTS;
}

DrawingRecord transform_symbol_local_drawing_record_to_schematic_global(
		const DrawingRecord &symbol_local_record,
		const ComponentInstance &component);

struct SchematicGlobalAxisAlignedBoundingBox {
	double minimum_x;
	double minimum_y;
	double maximum_x;
	double maximum_y;
	bool has_any_points;
};

void expand_global_bounding_box_to_include_point(
		SchematicGlobalAxisAlignedBoundingBox *bounding_box,
		double schematic_global_x,
		double schematic_global_y) {
	if (!bounding_box->has_any_points) {
		bounding_box->minimum_x = schematic_global_x;
		bounding_box->maximum_x = schematic_global_x;
		bounding_box->minimum_y = schematic_global_y;
		bounding_box->maximum_y = schematic_global_y;
		bounding_box->has_any_points = true;
		return;
	}
	if (schematic_global_x < bounding_box->minimum_x) bounding_box->minimum_x = schematic_global_x;
	if (schematic_global_x > bounding_box->maximum_x) bounding_box->maximum_x = schematic_global_x;
	if (schematic_global_y < bounding_box->minimum_y) bounding_box->minimum_y = schematic_global_y;
	if (schematic_global_y > bounding_box->maximum_y) bounding_box->maximum_y = schematic_global_y;
}

void accumulate_drawing_record_bounding_box_in_global_coordinates(
		const DrawingRecord &record_in_global_coordinates,
		SchematicGlobalAxisAlignedBoundingBox *bounding_box) {
	std::visit([&](const auto &concrete_record) {
		using ConcreteRecordType = std::decay_t<decltype(concrete_record)>;
		if constexpr (std::is_same_v<ConcreteRecordType, DrawingLineSegment>) {
			expand_global_bounding_box_to_include_point(bounding_box, concrete_record.x1, concrete_record.y1);
			expand_global_bounding_box_to_include_point(bounding_box, concrete_record.x2, concrete_record.y2);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingBox>) {
			expand_global_bounding_box_to_include_point(bounding_box, concrete_record.x1, concrete_record.y1);
			expand_global_bounding_box_to_include_point(bounding_box, concrete_record.x2, concrete_record.y2);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingPolygon>) {
			const size_t vertex_count = std::min(concrete_record.vertex_xs.size(), concrete_record.vertex_ys.size());
			for (size_t i = 0; i < vertex_count; ++i) {
				expand_global_bounding_box_to_include_point(
						bounding_box, concrete_record.vertex_xs[i], concrete_record.vertex_ys[i]);
			}
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingArc>) {
			expand_global_bounding_box_to_include_point(
					bounding_box, concrete_record.center_x - concrete_record.radius, concrete_record.center_y - concrete_record.radius);
			expand_global_bounding_box_to_include_point(
					bounding_box, concrete_record.center_x + concrete_record.radius, concrete_record.center_y + concrete_record.radius);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingText>) {
			expand_global_bounding_box_to_include_point(bounding_box, concrete_record.anchor_x, concrete_record.anchor_y);
		}
	}, record_in_global_coordinates);
}

SchematicGlobalAxisAlignedBoundingBox compute_global_bounding_box_for_component_drawing_records(
		const ComponentInstance &component) {
	SchematicGlobalAxisAlignedBoundingBox bounding_box;
	bounding_box.has_any_points = false;
	bounding_box.minimum_x = 0.0;
	bounding_box.maximum_x = 0.0;
	bounding_box.minimum_y = 0.0;
	bounding_box.maximum_y = 0.0;
	for (const auto &symbol_local_record : component.symbol_drawing_records_in_local_coordinates) {
		const DrawingRecord global_record =
				transform_symbol_local_drawing_record_to_schematic_global(symbol_local_record, component);
		accumulate_drawing_record_bounding_box_in_global_coordinates(global_record, &bounding_box);
	}
	return bounding_box;
}

godot::Area3D *create_clickable_button_area_for_component(
		Spice3DNode *spice3d_node,
		godot::Node3D *parent_node_for_area,
		const ComponentInstance &button_component) {
	const SchematicGlobalAxisAlignedBoundingBox bounding_box =
			compute_global_bounding_box_for_component_drawing_records(button_component);
	if (!bounding_box.has_any_points) return nullptr;

	const double bounding_box_width_in_world_x =
			(bounding_box.maximum_x - bounding_box.minimum_x)
			+ 2.0 * BUTTON_AREA_COLLISION_SHAPE_HORIZONTAL_MARGIN_IN_WORLD_UNITS;
	const double bounding_box_depth_in_world_z =
			(bounding_box.maximum_y - bounding_box.minimum_y)
			+ 2.0 * BUTTON_AREA_COLLISION_SHAPE_HORIZONTAL_MARGIN_IN_WORLD_UNITS;
	const double bounding_box_center_world_x = 0.5 * (bounding_box.minimum_x + bounding_box.maximum_x);
	const double bounding_box_center_world_z = 0.5 * (bounding_box.minimum_y + bounding_box.maximum_y);

	godot::Ref<godot::BoxShape3D> button_collision_shape_resource;
	button_collision_shape_resource.instantiate();
	button_collision_shape_resource->set_size(godot::Vector3(
			bounding_box_width_in_world_x,
			BUTTON_AREA_COLLISION_SHAPE_VERTICAL_EXTENT_IN_WORLD_UNITS,
			bounding_box_depth_in_world_z));

	godot::CollisionShape3D *button_collision_shape_node = memnew(godot::CollisionShape3D);
	button_collision_shape_node->set_shape(button_collision_shape_resource);

	godot::Area3D *button_clickable_area = memnew(godot::Area3D);
	button_clickable_area->set_ray_pickable(true);
	godot::Vector3 button_area_origin = schematic_xy_to_lying_flat_world_position(
			bounding_box_center_world_x, bounding_box_center_world_z);
	button_area_origin.y = 0.5 * BUTTON_AREA_COLLISION_SHAPE_VERTICAL_EXTENT_IN_WORLD_UNITS;
	button_clickable_area->set_position(button_area_origin);
	button_clickable_area->add_child(button_collision_shape_node);
	parent_node_for_area->add_child(button_clickable_area);

	const godot::String button_instance_name_godot_string =
			c_string_to_godot_string(button_component.instance_name);
	button_clickable_area->connect(
			"input_event",
			godot::Callable(spice3d_node, "on_button_area_input_event").bind(button_instance_name_godot_string));
	return button_clickable_area;
}

void render_drawing_record_in_global_coordinates(
		godot::Node3D *parent_node,
		const DrawingRecord &record_in_global_coordinates,
		const DrawingRenderMaterials &render_materials) {
	std::visit([&](const auto &concrete_record) {
		using ConcreteRecordType = std::decay_t<decltype(concrete_record)>;
		if constexpr (std::is_same_v<ConcreteRecordType, DrawingLineSegment>) {
			add_drawing_line_segment_in_global_coordinates(parent_node, concrete_record, render_materials.outline);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingBox>) {
			add_drawing_box_in_global_coordinates(parent_node, concrete_record, render_materials.outline, render_materials.fill);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingPolygon>) {
			add_drawing_polygon_in_global_coordinates(parent_node, concrete_record, render_materials.outline, render_materials.fill);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingArc>) {
			add_drawing_arc_tessellated_cylinders_in_global_coordinates(parent_node, concrete_record, render_materials.outline);
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingText>) {
			add_drawing_text_label_in_global_coordinates(parent_node, concrete_record, render_materials.text_color);
		}
	}, record_in_global_coordinates);
}

std::pair<double, double> transform_symbol_local_point_via_component(
		const ComponentInstance &component, double local_x, double local_y) {
	double schematic_global_x = 0.0;
	double schematic_global_y = 0.0;
	transform_symbol_local_point_to_schematic_global_point(
			component, local_x, local_y, &schematic_global_x, &schematic_global_y);
	return { schematic_global_x, schematic_global_y };
}

DrawingRecord transform_symbol_local_drawing_record_to_schematic_global(
		const DrawingRecord &symbol_local_record,
		const ComponentInstance &component) {
	return std::visit([&](const auto &concrete_record) -> DrawingRecord {
		using ConcreteRecordType = std::decay_t<decltype(concrete_record)>;
		if constexpr (std::is_same_v<ConcreteRecordType, DrawingLineSegment>) {
			const auto p1 = transform_symbol_local_point_via_component(component, concrete_record.x1, concrete_record.y1);
			const auto p2 = transform_symbol_local_point_via_component(component, concrete_record.x2, concrete_record.y2);
			DrawingLineSegment global_line;
			global_line.x1 = p1.first;  global_line.y1 = p1.second;
			global_line.x2 = p2.first;  global_line.y2 = p2.second;
			return global_line;
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingBox>) {
			const auto p1 = transform_symbol_local_point_via_component(component, concrete_record.x1, concrete_record.y1);
			const auto p2 = transform_symbol_local_point_via_component(component, concrete_record.x2, concrete_record.y2);
			DrawingBox global_box;
			global_box.x1 = p1.first;  global_box.y1 = p1.second;
			global_box.x2 = p2.first;  global_box.y2 = p2.second;
			global_box.filled = concrete_record.filled;
			return global_box;
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingPolygon>) {
			DrawingPolygon global_polygon;
			const size_t vertex_count = std::min(concrete_record.vertex_xs.size(), concrete_record.vertex_ys.size());
			global_polygon.vertex_xs.reserve(vertex_count);
			global_polygon.vertex_ys.reserve(vertex_count);
			for (size_t vertex_index = 0; vertex_index < vertex_count; ++vertex_index) {
				const auto p = transform_symbol_local_point_via_component(
						component, concrete_record.vertex_xs[vertex_index], concrete_record.vertex_ys[vertex_index]);
				global_polygon.vertex_xs.push_back(p.first);
				global_polygon.vertex_ys.push_back(p.second);
			}
			global_polygon.filled = concrete_record.filled;
			return global_polygon;
		} else if constexpr (std::is_same_v<ConcreteRecordType, DrawingArc>) {
			const auto center = transform_symbol_local_point_via_component(
					component, concrete_record.center_x, concrete_record.center_y);
			DrawingArc global_arc;
			global_arc.center_x = center.first;
			global_arc.center_y = center.second;
			global_arc.radius = concrete_record.radius;
			global_arc.start_angle_degrees =
					concrete_record.start_angle_degrees + component.rotation_quarter_turns * 90.0;
			global_arc.sweep_angle_degrees = concrete_record.sweep_angle_degrees;
			return global_arc;
		} else {
			const auto anchor = transform_symbol_local_point_via_component(
					component, concrete_record.anchor_x, concrete_record.anchor_y);
			DrawingText global_text;
			global_text.text = concrete_record.text;
			global_text.anchor_x = anchor.first;
			global_text.anchor_y = anchor.second;
			global_text.rotation_quarter_turns =
					(concrete_record.rotation_quarter_turns + component.rotation_quarter_turns) & 3;
			global_text.flip = concrete_record.flip ^ component.flip_flag;
			global_text.horizontal_size_factor = concrete_record.horizontal_size_factor;
			global_text.vertical_size_factor = concrete_record.vertical_size_factor;
			return global_text;
		}
	}, symbol_local_record);
}

godot::Ref<godot::StandardMaterial3D> build_drawing_fill_material() {
	godot::Ref<godot::StandardMaterial3D> fill_material;
	fill_material.instantiate();
	fill_material->set_albedo(godot::Color(0.95f, 0.85f, 0.4f));
	fill_material->set_metallic(0.1f);
	fill_material->set_roughness(0.55f);
	fill_material->set_cull_mode(godot::BaseMaterial3D::CULL_DISABLED);
	return fill_material;
}

DrawingRenderMaterials build_drawing_render_materials() {
	DrawingRenderMaterials materials;
	materials.outline = build_drawing_outline_material();
	materials.fill = build_drawing_fill_material();
	materials.text_color = godot::Color(0.95f, 0.92f, 0.85f);
	return materials;
}

godot::Color interpolate_voltage_into_wire_color(double voltage_volts, double vdd_volts) {
	const double saturation_factor = vdd_volts > 0.0
			? godot::Math::clamp(voltage_volts / vdd_volts, 0.0, 1.0)
			: 0.0;
	const godot::Color low_color(0.2f, 0.35f, 0.85f);
	const godot::Color high_color(0.95f, 0.95f, 0.4f);
	return low_color.lerp(high_color, saturation_factor);
}

godot::Color bus_integer_value_to_distinct_state_color(int integer_value, int bit_count) {
	const int distinct_state_count = (bit_count > 0) ? (1 << bit_count) : 1;
	const double hue_around_color_wheel = static_cast<double>(integer_value)
			/ static_cast<double>(distinct_state_count);
	godot::Color one_distinct_state_color;
	one_distinct_state_color.set_hsv(static_cast<float>(hue_around_color_wheel), 0.85f, 0.95f);
	return one_distinct_state_color;
}

void apply_albedo_and_emission_color_to_wire_mesh(
		godot::MeshInstance3D *wire_mesh_instance,
		const godot::Color &color_to_apply) {
	godot::Ref<godot::StandardMaterial3D> wire_material = wire_mesh_instance->get_material_override();
	if (wire_material.is_null()) return;
	wire_material->set_albedo(color_to_apply);
	wire_material->set_emission(color_to_apply * 0.4f);
}

void update_one_scalar_wire_mesh_albedo_from_voltage(
		godot::MeshInstance3D *wire_mesh_instance,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts) {
	const godot::Variant meta_value = wire_mesh_instance->get_meta(
			WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME);
	if (meta_value.get_type() != godot::Variant::STRING) return;
	const godot::String spice_node_name = static_cast<godot::String>(meta_value);
	if (!spice_node_name_to_voltage.has(spice_node_name)) return;
	const double voltage_volts = static_cast<double>(spice_node_name_to_voltage[spice_node_name]);
	apply_albedo_and_emission_color_to_wire_mesh(
			wire_mesh_instance, interpolate_voltage_into_wire_color(voltage_volts, vdd_volts));
}

void update_one_bus_wire_mesh_albedo_from_per_bit_voltages(
		godot::MeshInstance3D *wire_mesh_instance,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts) {
	const godot::Variant meta_value = wire_mesh_instance->get_meta(
			WIRE_MESH_INSTANCE_META_KEY_FOR_BUS_BIT_NET_NAMES_MSB_FIRST);
	if (meta_value.get_type() != godot::Variant::PACKED_STRING_ARRAY) return;
	const godot::PackedStringArray bit_net_names_msb_first = meta_value;
	const int bit_count = bit_net_names_msb_first.size();
	if (bit_count <= 0) return;
	const double bit_threshold_volts = 0.5 * vdd_volts;
	int aggregated_integer_value = 0;
	for (int one_bit_index_from_msb = 0; one_bit_index_from_msb < bit_count; ++one_bit_index_from_msb) {
		const godot::String one_bit_net_name = bit_net_names_msb_first[one_bit_index_from_msb];
		if (!spice_node_name_to_voltage.has(one_bit_net_name)) return;
		const double one_bit_voltage_volts = static_cast<double>(
				spice_node_name_to_voltage[one_bit_net_name]);
		const int one_bit_digital_value = (one_bit_voltage_volts > bit_threshold_volts) ? 1 : 0;
		aggregated_integer_value = (aggregated_integer_value << 1) | one_bit_digital_value;
	}
	apply_albedo_and_emission_color_to_wire_mesh(
			wire_mesh_instance,
			bus_integer_value_to_distinct_state_color(aggregated_integer_value, bit_count));
}

void update_one_wire_mesh_albedo_from_voltage(
		godot::MeshInstance3D *wire_mesh_instance,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts) {
	if (wire_mesh_instance->has_meta(WIRE_MESH_INSTANCE_META_KEY_FOR_BUS_BIT_NET_NAMES_MSB_FIRST)) {
		update_one_bus_wire_mesh_albedo_from_per_bit_voltages(
				wire_mesh_instance, spice_node_name_to_voltage, vdd_volts);
		return;
	}
	if (wire_mesh_instance->has_meta(WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME)) {
		update_one_scalar_wire_mesh_albedo_from_voltage(
				wire_mesh_instance, spice_node_name_to_voltage, vdd_volts);
	}
}

} // namespace

void add_rendered_meshes_for_schematic_to_parent_node(
		Spice3DNode *spice3d_node_for_button_signals,
		godot::Node3D *parent_node,
		const Schematic &loaded_schematic) {
	for (const auto &one_wire : loaded_schematic.wires) {
		add_wire_segment_capsule_to_parent_node(parent_node, one_wire);
	}

	const DrawingRenderMaterials drawing_materials = build_drawing_render_materials();
	for (const auto &top_level_record : loaded_schematic.top_level_drawing_records_in_global_coordinates) {
		render_drawing_record_in_global_coordinates(parent_node, top_level_record, drawing_materials);
	}

	const godot::Ref<godot::Material> placeholder_material = build_component_placeholder_material();
	for (const auto &one_component : loaded_schematic.component_instances) {
		if (one_component.symbol_was_resolved
				&& !one_component.symbol_drawing_records_in_local_coordinates.empty()) {
			for (const auto &symbol_local_record : one_component.symbol_drawing_records_in_local_coordinates) {
				const DrawingRecord global_record =
						transform_symbol_local_drawing_record_to_schematic_global(symbol_local_record, one_component);
				render_drawing_record_in_global_coordinates(parent_node, global_record, drawing_materials);
			}
		} else {
			add_component_placeholder_mesh_to_parent_node(parent_node, one_component, placeholder_material);
		}
		if (component_symbol_type_matches_button_vsource(one_component)) {
			create_clickable_button_area_for_component(spice3d_node_for_button_signals, parent_node, one_component);
		}
	}
}

void update_wire_mesh_colors_from_node_voltages(
		godot::Node3D *schematic_root_node,
		const godot::Dictionary &spice_node_name_to_voltage,
		double vdd_volts) {
	if (schematic_root_node == nullptr) return;
	const int child_count = schematic_root_node->get_child_count();
	for (int child_index = 0; child_index < child_count; ++child_index) {
		godot::Node *one_child = schematic_root_node->get_child(child_index);
		godot::MeshInstance3D *one_mesh_instance = godot::Object::cast_to<godot::MeshInstance3D>(one_child);
		if (one_mesh_instance == nullptr) continue;
		update_one_wire_mesh_albedo_from_voltage(one_mesh_instance, spice_node_name_to_voltage, vdd_volts);
	}
}

} // namespace spice3d
