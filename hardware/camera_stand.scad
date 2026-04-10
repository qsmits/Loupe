// ============================================================
// Camera Stand — lens + C-mount camera, vertical orientation
// ============================================================
// Lens mounts via its side flange (parallel to optical axis):
//   4× M3 tapped holes, 29.9mm square + 1/4"-20 centre thread.
// Bolts enter from the FRONT face of the mounting plate and
// thread into the lens — heads are accessible from the sample side.
//
// Three 6mm rods in a triangle for stiff, rotation-free guidance.
// Hull-based shapes throughout for a less boxy look.
//
// Part 1: base_and_column()   one print
// Part 2: carriage()          one print
//
// Hardware:
//   3× Ø6mm rod, ~220mm  (aluminium; rod tops ~10mm above col_h + base_h)
//   1× M4 × 10 set screw  (right side, into right rod bore; tap after printing)
//   4× M3 socket-head cap screws, length = plate_thick + lens_flange_depth
// ============================================================

$fn = 64;

// ---- Lens / camera ------------------------------------------
bolt_spacing       = 29.9;   // M3 pattern, centre-to-centre (square)
working_distance   = 55.2;   // front element → focal plane
front_bolt_offset  = 80.0;   // front element → front (lower) bolt pair

// ---- Rods ---------------------------------------------------
rod_d              = 6.0;
rod_press_d        = 5.9;    // press-fit in column
rod_slide_d        = 6.3;    // clearance in carriage
rod_length         = 220;
rod_tri_x          = 32;     // half-span of side rods  (64mm apart)
rod_tri_y          = 35;     // back rod: this far behind side rods (+Y)

// ---- Column towers ------------------------------------------
col_wall           = 11;     // wall around rod bore in column towers
tower_d            = rod_d + 2 * col_wall;   // 28mm tower diameter
col_h              = 80;     // tower height above base — rods protrude ~130mm above

// ---- Base ---------------------------------------------------
base_w             = 160;
base_d             = 140;
base_h             = 8;
fillet_r           = 8;      // base corner radius (cosmetic)
foot_d             = 8;
foot_depth         = 3;
foot_inset         = 14;

// ---- Carriage -----------------------------------------------
car_wall           = 9;
pillar_d           = rod_d + 2 * car_wall;   // 24mm carriage pillar diameter
car_h              = 50;     // carriage height — bolt pattern ±14.95mm well within this

// Mounting plate — lens presses on BACK face, bolt heads on FRONT face
plate_w            = 56;     // X width
plate_h_dim        = 56;     // Z height
plate_thick        = 10;     // Y depth (bolt head counterbores cut into front face)
plate_fwd          = 4;      // how far plate protrudes in front of carriage body (-Y)

// Hole sizes
m3_clear           = 3.4;   // M3 clearance
m3_head_d          = 5.8;   // M3 socket-head counterbore (DIN 912: Ø5.5 + 0.3 fit)
m3_head_depth      = 3.5;   // counterbore depth
tripod_d           = 5.1;   // 1/4"-20 tap drill
lock_d             = 3.3;   // M4 tap drill (set screw from right side)

// ---- Derived ------------------------------------------------
rod_left_x   = base_w / 2 - rod_tri_x;   // 48
rod_right_x  = base_w / 2 + rod_tri_x;   // 112
rod_sides_y  = base_d - rod_tri_y - col_wall - tower_d/2;  // side rods Y
rod_back_y   = rod_sides_y + rod_tri_y;                    // back rod Y

// Nominal focus: focal plane at base_h (sample on base plate)
nominal_bolt_cz = base_h + working_distance + front_bolt_offset + bolt_spacing / 2;
nominal_car_z   = nominal_bolt_cz - car_h / 2;

// ============================================================
// Helpers
// ============================================================

// Rounded-corner rectangle (XY) extruded to height h
module rounded_box(w, d, h, r) {
    hull()
    for (cx = [r, w-r]) for (cy = [r, d-r])
        translate([cx, cy, 0]) cylinder(r=r, h=h);
}

// ============================================================
// MODULE: base_and_column
// ============================================================
module base_and_column() {
    difference() {
        union() {
            // Rounded base plate
            rounded_box(base_w, base_d, base_h, fillet_r);

            // Three organic towers — hull of cylinders gives a
            // nicely rounded triangular cross-section
            hull() {
                translate([rod_left_x,  rod_sides_y, 0]) cylinder(d=tower_d, h=base_h + col_h);
                translate([rod_right_x, rod_sides_y, 0]) cylinder(d=tower_d, h=base_h + col_h);
                translate([base_w/2,    rod_back_y,  0]) cylinder(d=tower_d, h=base_h + col_h);
            }
        }

        // Rod press-fit bores
        translate([rod_left_x,  rod_sides_y, -0.1]) cylinder(d=rod_press_d, h=base_h + col_h + 0.2);
        translate([rod_right_x, rod_sides_y, -0.1]) cylinder(d=rod_press_d, h=base_h + col_h + 0.2);
        translate([base_w/2,    rod_back_y,  -0.1]) cylinder(d=rod_press_d, h=base_h + col_h + 0.2);

        // Rubber-foot counterbores
        for (fx = [foot_inset, base_w - foot_inset])
        for (fy = [foot_inset, base_d - foot_inset])
            translate([fx, fy, 0]) cylinder(d=foot_d, h=foot_depth);
    }
}

// ============================================================
// MODULE: carriage
// ============================================================
// Local origin: midpoint of side rods (X=0, Y=0), carriage bottom (Z=0).
//   −Y  →  front / sample side
//   +Y  →  column side (back rod at Y = +rod_tri_y)
//
// The lens presses against the BACK face of the mounting plate (at Y=0).
// M3 bolts enter from the FRONT face (at Y = −plate_thick − plate_fwd)
// and thread into the lens tapped holes.
module carriage() {
    bpz = car_h / 2;   // Z of bolt-pattern centre

    // Carriage body: organic hull of three pillars
    // Side pillars at (±rod_tri_x, 0); back pillar at (0, +rod_tri_y)
    // Front face of hull is flat at Y=0 between the two side pillars
    body_y_min = -(pillar_d / 2);               // front extent of hull
    plate_back_y = body_y_min - plate_fwd;      // back face of mounting plate
    plate_front_y = plate_back_y - plate_thick; // front face (bolt-head side)

    difference() {
        union() {
            // Organic body
            hull() {
                translate([-rod_tri_x, 0,          0]) cylinder(d=pillar_d, h=car_h);
                translate([ rod_tri_x, 0,          0]) cylinder(d=pillar_d, h=car_h);
                translate([0,          rod_tri_y,  0]) cylinder(d=pillar_d, h=car_h);
            }

            // Flat mounting plate, centered on bolt pattern
            translate([-plate_w/2, plate_front_y, bpz - plate_h_dim/2])
                cube([plate_w, plate_thick, plate_h_dim]);
        }

        // Rod sliding bores
        translate([-rod_tri_x, 0,         -0.1]) cylinder(d=rod_slide_d, h=car_h + 0.2);
        translate([ rod_tri_x, 0,         -0.1]) cylinder(d=rod_slide_d, h=car_h + 0.2);
        translate([0,          rod_tri_y, -0.1]) cylinder(d=rod_slide_d, h=car_h + 0.2);

        // M4 lock-screw bore: from right outer face into right rod bore, mid-height
        right_outer = rod_tri_x + pillar_d / 2;
        translate([right_outer + 0.1, 0, bpz])
            rotate([0, -90, 0])
                cylinder(d=lock_d, h=pillar_d / 2 + rod_d / 2 + 1);

        // 4× M3 clearance holes + counterbores through mounting plate
        // Holes drill in +Y: from front face through to back (lens) face
        for (bx = [-bolt_spacing/2, bolt_spacing/2])
        for (bz = [-bolt_spacing/2, bolt_spacing/2]) {
            // Clearance bore all the way through
            translate([bx, plate_front_y - 0.1, bpz + bz])
                rotate([-90, 0, 0])
                    cylinder(d=m3_clear, h=plate_thick + 0.2);
            // Socket-head counterbore from front face
            translate([bx, plate_front_y - 0.1, bpz + bz])
                rotate([-90, 0, 0])
                    cylinder(d=m3_head_d, h=m3_head_depth + 0.1);
        }

        // 1/4"-20 tripod hole at bolt-pattern centre
        translate([0, plate_front_y - 0.1, bpz])
            rotate([-90, 0, 0])
                cylinder(d=tripod_d, h=plate_thick + 0.2);
    }
}

// ============================================================
// RENDER — comment out one part for STL export
// ============================================================

color("SteelBlue", 0.85)
    base_and_column();

color("Coral", 0.85)
    translate([base_w/2, rod_sides_y, nominal_car_z])
        carriage();

color("Silver", 0.6) {
    translate([rod_left_x,  rod_sides_y, 0]) cylinder(d=rod_d, h=rod_length);
    translate([rod_right_x, rod_sides_y, 0]) cylinder(d=rod_d, h=rod_length);
    translate([base_w/2,    rod_back_y,  0]) cylinder(d=rod_d, h=rod_length);
}
