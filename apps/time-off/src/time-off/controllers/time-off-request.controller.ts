import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TimeOffRequestService } from '../services/time-off-request.service';
import { CreateTimeOffRequestDto } from '../dtos/create-time-off-request.dto';
import { ApproveRequestDto } from '../dtos/approve-request.dto';
import { RejectRequestDto } from '../dtos/reject-request.dto';
import { CancelRequestDto } from '../dtos/cancel-request.dto';
import { TimeOffRequestEntity } from '../entities/time-off-request.entity';

/**
 * TimeOffRequestController — REST interface for the time-off request lifecycle.
 *
 * Route design matches TRD §7:
 *   POST   /time-off/requests             — submit a new request
 *   GET    /time-off/requests             — list requests (filterable by employeeId)
 *   GET    /time-off/requests/:id         — get single request
 *   PATCH  /time-off/requests/:id/approve — manager approves
 *   PATCH  /time-off/requests/:id/reject  — manager rejects
 *   PATCH  /time-off/requests/:id/cancel  — employee cancels
 *   PATCH  /time-off/requests/:id/retry   — ops retries a stuck HCM_FAILED request
 *
 * Authentication (non-goal for this assessment):
 * In production, employeeId and managerId would be extracted from the JWT
 * rather than passed in the body. The DTOs include them explicitly here
 * to keep the assessment runnable without an auth layer.
 */
@ApiTags('time-off-requests')
@Controller('time-off/requests')
export class TimeOffRequestController {
  constructor(private readonly requestService: TimeOffRequestService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new time-off request' })
  @ApiResponse({
    status: 201,
    description: 'Request created in PENDING_APPROVAL state',
  })
  @ApiResponse({ status: 400, description: 'Invalid dates or missing fields' })
  @ApiResponse({ status: 409, description: 'End date before start date' })
  async createRequest(
    @Body() dto: CreateTimeOffRequestDto,
  ): Promise<TimeOffRequestEntity> {
    return this.requestService.createRequest(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List time-off requests' })
  @ApiQuery({
    name: 'employeeId',
    required: false,
    description: 'Filter by employee',
  })
  @ApiResponse({ status: 200, type: [TimeOffRequestEntity] })
  async listRequests(
    @Query('employeeId') employeeId?: string,
  ): Promise<TimeOffRequestEntity[]> {
    return this.requestService.findAll(employeeId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single time-off request by ID' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, type: TimeOffRequestEntity })
  @ApiResponse({ status: 404, description: 'Request not found' })
  async getRequest(@Param('id') id: string): Promise<TimeOffRequestEntity> {
    return this.requestService.findById(id);
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary: 'Manager approves a pending request',
    description:
      'Triggers a live HCM balance check, optimistically reserves days, ' +
      'submits the deduction to HCM, and commits or rolls back based on HCM response.',
  })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({
    status: 200,
    description: 'Approved and HCM notified (HCM_SUBMITTED)',
  })
  @ApiResponse({
    status: 409,
    description: 'Request not in PENDING_APPROVAL, or insufficient balance',
  })
  @ApiResponse({
    status: 503,
    description: 'HCM unavailable — approval blocked',
  })
  async approveRequest(
    @Param('id') id: string,
    @Body() dto: ApproveRequestDto,
  ): Promise<TimeOffRequestEntity> {
    return this.requestService.approveRequest(id, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Manager rejects a pending request' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request moved to REJECTED state' })
  @ApiResponse({ status: 409, description: 'Request not in PENDING_APPROVAL' })
  async rejectRequest(
    @Param('id') id: string,
    @Body() dto: RejectRequestDto,
  ): Promise<TimeOffRequestEntity> {
    return this.requestService.rejectRequest(id, dto);
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary: 'Employee cancels their own request',
    description:
      'If already HCM_SUBMITTED, triggers an HCM reversal before cancelling locally.',
  })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request cancelled' })
  @ApiResponse({
    status: 409,
    description: 'Request is in a terminal state (cannot be cancelled)',
  })
  async cancelRequest(
    @Param('id') id: string,
    @Body() dto: CancelRequestDto,
  ): Promise<TimeOffRequestEntity> {
    return this.requestService.cancelRequest(id, dto);
  }

  @Patch(':id/retry')
  @ApiOperation({
    summary: 'Retry HCM submission for a failed request',
    description:
      'Only valid for requests in HCM_FAILED state. Retries the deduction call ' +
      'using the same idempotency key — safe to call multiple times.',
  })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Retry submitted' })
  @ApiResponse({
    status: 409,
    description: 'Request is not in HCM_FAILED state',
  })
  async retryHcmSubmit(@Param('id') id: string): Promise<TimeOffRequestEntity> {
    return this.requestService.retryHcmSubmit(id);
  }
}
