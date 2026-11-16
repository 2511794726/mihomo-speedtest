<script setup>
import { ProgressRoot, ProgressIndicator } from 'reka-ui';
import { cn } from '../../lib/utils.js';

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  active: { type: Boolean, default: false },
  class: { type: String, default: '' },
});
</script>

<template>
  <ProgressRoot
    :model-value="props.modelValue"
    :class="cn('relative h-2 w-full overflow-hidden rounded-full bg-white/[0.08] border border-white/5', props.class)"
  >
    <ProgressIndicator
      class="relative h-full w-full flex-1 overflow-hidden bg-gradient-to-r from-[#0A84FF] to-[#30D158] transition-transform duration-300 ease-out"
      :style="{ transform: `translateX(-${100 - Math.min(100, Math.max(0, props.modelValue))}%)` }"
    >
      <span v-if="props.active" class="progress-shimmer pointer-events-none absolute inset-y-0 left-0 w-1/2" />
    </ProgressIndicator>
  </ProgressRoot>
</template>
