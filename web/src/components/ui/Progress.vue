<script setup>
import { ProgressRoot, ProgressIndicator } from 'reka-ui';
import { cn } from '../../lib/utils.js';

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  class: { type: String, default: '' },
});
</script>

<template>
  <ProgressRoot
    :model-value="props.modelValue"
    :class="cn('relative h-2 w-full overflow-hidden rounded-full bg-white/[0.08] border border-white/5', props.class)"
  >
    <ProgressIndicator
      class="h-full w-full flex-1 bg-gradient-to-r from-[#0A84FF] to-[#30D158] transition-transform duration-300 ease-out"
      :style="{ transform: `translateX(-${100 - Math.min(100, Math.max(0, props.modelValue))}%)` }"
    />
  </ProgressRoot>
</template>
