<script setup>
import { cn } from '../../lib/utils.js';

const props = defineProps({
  class: { type: String, default: '' },
});
</script>

<template>
  <section
    :class="
      cn(
        'rounded-2xl bg-slate-900/55 backdrop-blur-2xl backdrop-saturate-150 border border-white/15 ring-1 ring-inset ring-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.36)]',
        props.class,
      )
    "
  >
    <slot />
  </section>
</template>
