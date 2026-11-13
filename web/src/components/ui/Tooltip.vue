<script setup>
import { TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent } from 'reka-ui';
</script>

<template>
  <TooltipRoot :delay-duration="150">
    <TooltipTrigger as-child>
      <span
        class="inline-flex items-center text-slate-400 hover:text-slate-100 transition-colors cursor-help"
        @click.stop
      >
        <slot name="trigger" />
      </span>
    </TooltipTrigger>
    <TooltipPortal>
      <TooltipContent
        side="top"
        :side-offset="8"
        class="z-50 w-76 rounded-xl bg-slate-900/90 backdrop-blur-3xl backdrop-saturate-150 border border-white/20 p-3.5 text-xs leading-relaxed text-slate-200 shadow-2xl"
      >
        <slot />
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
