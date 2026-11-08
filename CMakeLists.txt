cmake_minimum_required(VERSION 3.24)
project(bomberman_online_recomp VERSION 0.1.0 LANGUAGES C CXX)

# Bomberman Online (USA, MK-51065 V1.004) as a native PC port, built with dreamcomp.
# dreamcomp is vendored in this repository at ./dreamcomp — everything is self-contained,
# no external checkout required.
set(DREAMCOMP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/dreamcomp" CACHE PATH "dreamcomp checkout (vendored)")
message(STATUS "dreamcomp: ${DREAMCOMP_DIR}")
add_subdirectory(${DREAMCOMP_DIR} dreamcomp)
add_subdirectory(game)
