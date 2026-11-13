<script setup>
import { cn } from '../../lib/utils.js';

const model = defineModel({ type: [String, Number], default: '' });

const props = defineProps({
  class: { type: String, default: '' },
});
</script>

<template>
  <input
    v-model="model"
    :class="
      cn(
        'h-10 w-full rounded-xl bg-white/[0.06] backdrop-blur-xl border border-white/10 px-3.5 text-sm text-slate-100 placeholder:text-slate-500 transition-colors focus:outline-none focus:border-[#0A84FF]/70 focus:ring-2 focus:ring-[#0A84FF]/25 disabled:opacity-50',
        props.class,
      )
    "
  />
</template>
