<script setup>
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogClose,
} from 'reka-ui';
import { Icon } from '@iconify/vue';

const open = defineModel('open', { type: Boolean, default: false });

const props = defineProps({
  title: { type: String, default: '' },
});
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay-anim fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogContent
        class="dialog-content-anim fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-3xl max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-slate-900/85 backdrop-blur-3xl backdrop-saturate-150 border border-white/20 ring-1 ring-inset ring-white/10 p-6 shadow-2xl focus:outline-none"
      >
        <div class="mb-4 flex items-center justify-between gap-4">
          <DialogTitle class="flex items-center gap-2 text-base font-semibold text-slate-100">
            <slot name="icon" />
            <span>{{ props.title }}</span>
          </DialogTitle>
          <DialogClose
            class="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer"
          >
            <Icon icon="mdi:close" class="h-4 w-4" />
          </DialogClose>
        </div>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
