/* glibc 2.21's eager relocation path combines .rel.dyn and .rel.plt by size.
 * Keep them adjacent: LLD otherwise inserts .ARM.exidx between the two.
 * Preserve -z now / RELRO; do not replace or patch the archived loader.
 */
SECTIONS { .ARM.exidx : { *(.ARM.exidx*) } } INSERT BEFORE .rel.dyn;
